/**
 * goal — an agent that says "done" is not done until a verifier agrees.
 *
 * The failure mode this extension exists for: the task spans many steps, the
 * agent completes the easy 90%, declares success, and the turn ends with the
 * goal half-met. Nobody is checking the claim against the goal — except you,
 * after the fact.
 *
 * Claude Code solves this with stop hooks: when the agent finishes, a hook can
 * block the stop and hand back a reason, and the query loop simply keeps going
 * (src/query/stopHooks.ts: a blocking hook becomes an injected user message
 * and the run continues). pi has the same seam — `agent_before_settle` is the
 * final actionable boundary before a run ends, and the handler may append
 * entries and set `continue = true` to request exactly one more run.
 *
 * ## How this extension uses the seam
 *
 *   /goal <text>     arm a goal
 *   /goal            show it; /goal clear dismiss it
 *
 * Every time the agent settles while a goal is armed, a verifier model call
 * receives the goal plus a trimmed digest of the transcript and must answer
 * `VERDICT: DONE | NOT_DONE | UNREACHABLE` with a reason:
 *
 *   - DONE        → goal cleared, normal settle. The claim survived an audit.
 *   - NOT_DONE    → the run is continued with the verifier's reason injected
 *                   as a visible message, so the next turn starts from what
 *                   is actually missing instead of the agent's own summary.
 *   - UNREACHABLE → goal cleared with the blocker reported. A verifier that
 *                   cannot be satisfied must say so rather than loop.
 *
 * Two guards keep the loop honest. A verifier that returns the *same* blocker
 * twice in a row is treated as evidence the agent cannot make progress — the
 * goal is cleared with that blocker reported, rather than burning turns on a
 * treadmill. And a check ceiling (default 12) bounds the whole loop per goal.
 *
 * The checker is a nested `streamSimple` call on the active model (or
 * PI_GOAL_CHECK_MODEL) with reasoning off — deliberately cheap, since it runs
 * after every settle while a goal is armed. Its failure is fail-open: a broken
 * verifier must never trap a finished run, so errors settle normally.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_CHECKS = Number(process.env.PI_GOAL_MAX_CHECKS ?? 12);
const CHECK_MODEL = process.env.PI_GOAL_CHECK_MODEL?.trim() || undefined;
const OFF = process.env.PI_GOAL_OFF === "1";
/** Same normalized blocker twice in a row → declare no progress. */
const NO_PROGRESS_STREAK = 2;

/** Per-message truncation in the verifier's transcript digest. */
const DIGEST_MSG_CHARS = 400;
/** Cap on the whole digest sent to the verifier. */
const DIGEST_MAX_CHARS = 10_000;
/** Digest window: only the tail of the transcript is relevant. */
const DIGEST_LAST_MESSAGES = 40;

/** Structural shapes for what pi hands us, kept loose on purpose: the
 * extension must survive minor version drift in the event types. */
interface LlmMessage {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
}
interface SettleEvent {
	outcome?: string;
	continue?: boolean;
	entries?: unknown[];
	context?: {
		canContinue?: boolean;
		llmMessages?: LlmMessage[];
	};
}
interface UiContext {
	ui?: {
		notify?: (text: string, level?: string) => void;
		setStatus?: (key: string, text: string) => void;
	};
}
interface StreamChunk {
	type?: string;
	message?: { content?: unknown };
	error?: unknown;
}

const CHECKER_SYSTEM = [
	"You are a strict completion verifier for a coding agent. You are given a goal",
	"and a digest of what the agent actually did. Decide from evidence in the",
	"digest, not from the agent's own claims of success.",
	"",
	"Answer in exactly this format, nothing else:",
	"VERDICT: DONE | NOT_DONE | UNREACHABLE",
	"<1-3 sentences of reason>",
	"",
	"VERDICT meaning:",
	"- DONE: the goal is fully accomplished per the evidence.",
	"- NOT_DONE: any part of the goal is unmet, unverified, or only claimed.",
	"  Name the concrete missing steps in the reason.",
	"- UNREACHABLE: the goal cannot be achieved in this environment",
	"  (missing access, impossible request). Say what blocks it.",
].join("\n");

function fmtStatus(state: { goal: string | null; checks: number }): string {
	if (!state.goal) return "goal: none";
	const short = state.goal.length > 40 ? `${state.goal.slice(0, 39)}…` : state.goal;
	return `goal: ${short} (check ${state.checks}/${MAX_CHECKS})`;
}

/** Flatten a message's text/tool blocks into a short one-line-ish digest. */
function digestMessage(m: LlmMessage): string {
	const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
	const text = (limit: number): string => {
		const joined = blocks
			.filter((b) => b?.type === "text")
			.map((b) => String((b as { text?: string }).text ?? ""))
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		return joined.length > limit ? `${joined.slice(0, limit - 1)}…` : joined;
	};
	if (m.role === "user") return `USER: ${text(DIGEST_MSG_CHARS)}`;
	if (m.role === "assistant") {
		const calls = blocks
			.filter((b) => b?.type === "toolCall")
			.map((b) => {
				const tc = b as { name?: string; arguments?: Record<string, unknown> };
				const arg = tc.arguments?.command ?? tc.arguments?.path ?? tc.arguments?.file_path ?? "";
				return `${tc.name ?? "tool"}(${String(arg).slice(0, 80)})`;
			})
			.join("; ");
		const prose = text(DIGEST_MSG_CHARS);
		return `ASSISTANT: ${[prose, calls].filter(Boolean).join(" | ")}`;
	}
	if (m.role === "toolResult") return `TOOL ${m.toolName ?? ""}: ${text(200)}`;
	return `${m.role ?? "?"}`.slice(0, DIGEST_MSG_CHARS);
}

function buildDigest(llmMessages: LlmMessage[] | undefined): string {
	const messages = Array.isArray(llmMessages) ? llmMessages.slice(-DIGEST_LAST_MESSAGES) : [];
	const lines = messages.map(digestMessage);
	let digest = lines.join("\n");
	if (digest.length > DIGEST_MAX_CHARS) {
		digest = digest.slice(digest.length - DIGEST_MAX_CHARS);
		// Re-align to a message boundary so the verifier never sees a half line.
		digest = digest.slice(digest.indexOf("\n") + 1);
	}
	return digest || "(no transcript)";
}

function parseVerdict(output: string): { verdict: "DONE" | "NOT_DONE" | "UNREACHABLE"; reason: string } | null {
	const m = output.match(/VERDICT:\s*(DONE|NOT_DONE|UNREACHABLE)/i);
	if (m) {
		const verdict = m[1].toUpperCase().replace("_", "_") as "DONE" | "NOT_DONE" | "UNREACHABLE";
		const rest = output.slice((m.index ?? 0) + m[0].length).trim();
		return { verdict, reason: rest || "(no reason given)" };
	}
	// Loose fallbacks for models that ignore the format.
	if (/unreachable|impossible|cannot be (?:done|achieved|reached)/i.test(output))
		return { verdict: "UNREACHABLE", reason: output.trim().slice(0, 300) };
	if (/not[ _-]?done|incomplete|not yet/i.test(output))
		return { verdict: "NOT_DONE", reason: output.trim().slice(0, 300) };
	if (/\bdone\b|complete/i.test(output)) return { verdict: "DONE", reason: output.trim().slice(0, 300) };
	return null;
}

function normalizeReason(reason: string): string {
	return reason.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);
}

/** Extract the checker's text output from a finished stream message. */
function extractText(message: { content?: unknown }): string {
	const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
	return blocks
		.filter((b) => b?.type === "text")
		.map((b) => String((b as { text?: string }).text ?? ""))
		.join("\n")
		.trim();
}

export default async function (pi: ExtensionAPI) {
	const state = {
		goal: null as string | null,
		checks: 0,
		lastReasonKey: null as string | null,
		sameStreak: 0,
		failures: 0,
	};

	const notify = (ctx: UiContext, text: string) => {
		try {
			ctx.ui?.notify?.(text, "info");
		} catch {
			console.log(`[pi-goal] ${text}`);
		}
	};
	const setStatus = (ctx: UiContext) => {
		try {
			ctx.ui?.setStatus?.("goal", fmtStatus(state));
		} catch {
			// Status must never break the boundary.
		}
	};

	/** One verifier call. Returns the parsed verdict, or null when the call
	 * failed (fail-open: the caller lets the run settle). */
	async function verify(
		ctx: unknown,
	): Promise<{ verdict: "DONE" | "NOT_DONE" | "UNREACHABLE"; reason: string } | null> {
		const anyCtx = ctx as {
			model?: unknown;
			modelRegistry?: {
				streamSimple?: (model: unknown, context: unknown, options?: unknown) => AsyncIterable<StreamChunk>;
			};
		};
		const model = anyCtx?.model;
		const stream = anyCtx?.modelRegistry?.streamSimple;
		if (!model || typeof stream !== "function") return null;

		// Resolving the checker model here (per check, not per goal) means
		// runtime-registered providers and model switches mid-session are fine.
		let checkerModel: unknown = model;
		if (CHECK_MODEL) {
			const slash = CHECK_MODEL.indexOf("/");
			checkerModel =
				slash === -1
					? { provider: "", id: CHECK_MODEL }
					: { provider: CHECK_MODEL.slice(0, slash), id: CHECK_MODEL.slice(slash + 1) };
		}

		const userText = [
			`GOAL: ${state.goal}`,
			"",
			"TRANSCRIPT DIGEST (most recent last):",
			buildDigest((ctx as { settleEvent?: SettleEvent }).settleEvent?.context?.llmMessages),
		].join("\n");

		try {
			const events = stream.call(anyCtx.modelRegistry, checkerModel, {
				systemPrompt: CHECKER_SYSTEM,
				messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
			}, { reasoning: "off" });
			let final: StreamChunk | null = null;
			for await (const chunk of events) {
				if (chunk?.type === "done" || chunk?.type === "error") final = chunk;
			}
			if (!final || final.type !== "done") return null;
			const output = extractText(final.message ?? {});
			return output ? parseVerdict(output) : null;
		} catch {
			return null;
		}
	}

	pi.on("agent_before_settle", async (event, ctx) => {
		const settle = event as unknown as SettleEvent;
		if (OFF || !state.goal) return;
		// Only audit clean finishes: aborts and provider errors must settle
		// untouched, and pi's own canContinue guard wins over ours.
		if (settle.outcome !== "completed" || !settle.context?.canContinue) return;

		state.checks++;
		const ctxAny = ctx as UiContext & { settleEvent?: SettleEvent };
		ctxAny.settleEvent = settle;
		setStatus(ctxAny);

		const verdict = await verify(ctx);
		if (!verdict) {
			// Fail-open. Count consecutive failures so a permanently broken
			// checker stops spamming the transcript with failed audits.
			state.failures++;
			if (state.failures >= 3) {
				notify(ctxAny, `pi-goal: verifier failed ${state.failures}× — goal paused, run /goal <text> to re-arm`);
				state.goal = null;
				setStatus(ctxAny);
			} else {
				notify(ctxAny, "pi-goal: goal check failed — settling; will re-check next time");
			}
			return;
		}
		state.failures = 0;

		if (verdict.verdict === "DONE") {
			const checks = state.checks;
			state.goal = null;
			state.checks = 0;
			state.lastReasonKey = null;
			state.sameStreak = 0;
			setStatus(ctxAny);
			notify(ctxAny, `pi-goal: goal reached and verified ✓ (${checks} check${checks === 1 ? "" : "s"})`);
			return;
		}

		if (verdict.verdict === "UNREACHABLE") {
			state.goal = null;
			state.checks = 0;
			state.lastReasonKey = null;
			state.sameStreak = 0;
			setStatus(ctxAny);
			notify(ctxAny, `pi-goal: goal marked unreachable — ${verdict.reason}`);
			return;
		}

		// NOT_DONE — decide between "keep pushing" and "no progress".
		// The same normalized blocker on two consecutive checks means the
		// agent is on a treadmill, not making progress.
		const reasonKey = normalizeReason(verdict.reason);
		if (reasonKey && reasonKey === state.lastReasonKey) {
			state.sameStreak++;
		} else {
			state.sameStreak = 0;
			state.lastReasonKey = reasonKey;
		}
		if (state.sameStreak >= NO_PROGRESS_STREAK - 1) {
			const blocker = verdict.reason;
			state.goal = null;
			state.checks = 0;
			state.lastReasonKey = null;
			state.sameStreak = 0;
			setStatus(ctxAny);
			notify(ctxAny, `pi-goal: no progress toward the goal — clearing it. Repeating blocker: ${blocker}`);
			return;
		}

		if (state.checks >= MAX_CHECKS) {
			const goal = state.goal;
			state.goal = null;
			state.checks = 0;
			state.lastReasonKey = null;
			state.sameStreak = 0;
			setStatus(ctxAny);
			notify(ctxAny, `pi-goal: gave up after ${MAX_CHECKS} checks — goal cleared (was: ${goal})`);
			return;
		}

		// The Claude Code stop-hook move: block the stop, inject the reason,
		// let the loop continue from what is actually missing.
		settle.continue = true;
		settle.entries?.push({
			type: "custom_message",
			customType: "pi-goal",
			content:
				`[pi-goal] The goal is NOT reached yet — keep working.\n` +
				`Goal: ${state.goal}\n` +
				`Verifier: ${verdict.reason}\n` +
				`Address the missing parts now. When you believe the goal is met, just finish; it will be verified again.`,
			display: true,
		} as never);
	});

	pi.registerCommand("goal", {
		description: "Set a goal the agent is held to: /goal <text> — /goal shows it — /goal clear dismisses it",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["clear"].filter((s) => s.startsWith(prefix));
			return subs.length > 0 ? subs.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const cmdCtx = ctx as UiContext;
			const text = args.trim();
			if (text.toLowerCase() === "clear") {
				const had = state.goal;
				state.goal = null;
				state.checks = 0;
				state.lastReasonKey = null;
				state.sameStreak = 0;
				state.failures = 0;
				setStatus(cmdCtx);
				notify(cmdCtx, had ? `pi-goal: goal cleared (was: ${had})` : "pi-goal: no goal set");
				return;
			}
			if (!text) {
				notify(cmdCtx, state.goal ? fmtStatus(state) : "pi-goal: no goal set. Usage: /goal <text>");
				return;
			}
			state.goal = text;
			state.checks = 0;
			state.lastReasonKey = null;
			state.sameStreak = 0;
			state.failures = 0;
			setStatus(cmdCtx);
			notify(cmdCtx, `pi-goal: goal armed — the agent will be verified against it on every finish:\n${text}`);
		},
	});
}
