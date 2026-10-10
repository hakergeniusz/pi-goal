/**
 * pi-goal v0.2 — Claude Code /goal behavior for pi.
 *
 * /goal <condition> arms a session goal and immediately starts a turn with
 * the condition as the directive. After every turn a cheap verifier model
 * judges the condition against the transcript:
 *   NOT_DONE    → continue with the reason as guidance for the next turn
 *   DONE        → record an achieved entry, clear the goal
 *   UNREACHABLE → record a failed entry, clear the goal
 * No tool use for several turns pauses the loop but KEEPS the goal;
 * evaluation resumes on the next prompt. Turn failures keep the goal armed.
 * Goal state persists in session custom entries, so resume restores it.
 *
 * Model: PI_GOAL_CHECK_MODEL (default: the session's active model — set this
 * to a small fast model to mirror Claude Code's evaluator cost profile).
 * Env: PI_GOAL_MAX_CHECKS (default 12), PI_GOAL_STALL_TURNS (default 3),
 * PI_GOAL_OFF=1 disables.
 */
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	CustomEntry,
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

const MAX_CHECKS = Number(process.env.PI_GOAL_MAX_CHECKS ?? 12);
const CHECK_MODEL = process.env.PI_GOAL_CHECK_MODEL?.trim() || undefined;
const STALL_TURNS = Number(process.env.PI_GOAL_STALL_TURNS ?? 3);
const OFF = process.env.PI_GOAL_OFF === "1";

const DIGEST_MSG_CHARS = 400;
const DIGEST_MAX_CHARS = 10_000;
const DIGEST_LAST_MESSAGES = 40;
const STORE_TYPE = "pi-goal";

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

type Verdict = "DONE" | "NOT_DONE" | "UNREACHABLE";

interface GoalState {
	goal: string | null;
	checks: number; // verifier evaluations performed
	turns: number; // turns evaluated while armed
	startedAt: number;
	spentTokens: number; // verifier tokens (best effort)
	lastReason: string | null;
	achieved: string | null; // last achieved condition, for status
	idleTurns: number; // consecutive evaluated turns with no tool use
	failures: number; // consecutive verifier errors
	evalPending: boolean; // a turn ended without evaluation (settle backstop)
	deferredNotice: boolean; // background-deferral notice already shown
}

const freshState = (): GoalState => ({
	goal: null,
	checks: 0,
	turns: 0,
	startedAt: 0,
	spentTokens: 0,
	lastReason: null,
	achieved: null,
	idleTurns: 0,
	failures: 0,
	evalPending: false,
	deferredNotice: false,
});

function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
	return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}

function fmtTokens(n: number): string {
	return n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** Compact a message for the digest; tool calls keep name + short args. */
function compactMessage(m: unknown): string {
	if (typeof m === "string") return m.slice(0, DIGEST_MSG_CHARS);
	if (m === null || typeof m !== "object") return String(m).slice(0, DIGEST_MSG_CHARS);
	const msg = m as { role?: unknown; content?: unknown; toolName?: unknown };
	const role = typeof msg.role === "string" ? msg.role : "message";
	const c = msg.content;
	if (typeof c === "string") return `${role}: ${c.slice(0, DIGEST_MSG_CHARS)}`;
	if (!Array.isArray(c))
		return `${role}: ${JSON.stringify(c ?? msg.toolName ?? "").slice(0, DIGEST_MSG_CHARS)}`;
	const parts: string[] = [];
	for (const b of c) {
		if (typeof b === "string") {
			parts.push(b.slice(0, DIGEST_MSG_CHARS));
			continue;
		}
		if (b === null || typeof b !== "object") continue;
		const block = b as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string")
			parts.push(block.text.slice(0, DIGEST_MSG_CHARS));
		else if (block.type === "toolCall")
			parts.push(
				`[tool ${String(block.name ?? "?")}: ${JSON.stringify(block.arguments ?? {}).slice(0, 160)}]`,
			);
		else if (block.type === "toolResult" || typeof block.toolName === "string")
			parts.push(
				`[result ${String(block.toolName ?? "?")}: ${JSON.stringify(block.content ?? block.text ?? "").slice(0, 160)}]`,
			);
	}
	return `${role}: ${parts.join(" | ").slice(0, DIGEST_MSG_CHARS * 2)}`;
}

/** Last N messages, newest last, hard-capped so the check stays cheap. */
function buildDigest(llmMessages: unknown): string {
	const arr = Array.isArray(llmMessages) ? llmMessages : [];
	const lines = arr.slice(-DIGEST_LAST_MESSAGES).map(compactMessage);
	let digest = lines.join("\n");
	if (digest.length > DIGEST_MAX_CHARS)
		digest = `…(truncated)…\n${digest.slice(-DIGEST_MAX_CHARS)}`;
	return digest;
}

function parseVerdict(text: string): { verdict: Verdict; reason: string } | null {
	const m = text.match(/VERDICT\s*:\s*(DONE|NOT_DONE|UNREACHABLE)/i);
	if (!m) return null;
	const firstLine = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, 3)
		.join(" ");
	return { verdict: m[1].toUpperCase() as Verdict, reason: firstLine.slice(0, 300) };
}

function hasToolUse(event: TurnEndEvent | AgentBeforeSettleEvent): boolean {
	if ("toolResults" in event && Array.isArray(event.toolResults) && event.toolResults.length > 0)
		return true;
	const msg = ("message" in event ? event.message : undefined) as { content?: unknown } | null;
	if (msg && Array.isArray(msg.content))
		return msg.content.some(
			(b) => b !== null && typeof b === "object" && (b as { type?: unknown }).type === "toolCall",
		);
	return false;
}

export default function activate(pi: ExtensionAPI) {
	if (OFF) return;
	const state: GoalState = freshState();

	const snapshot = () => ({
		v: 1,
		goal: state.goal,
		checks: state.checks,
		turns: state.turns,
		startedAt: state.startedAt,
		spentTokens: state.spentTokens,
		lastReason: state.lastReason,
		achieved: state.achieved,
	});

	function persist() {
		try {
			pi.appendEntry(STORE_TYPE, snapshot());
		} catch {
			/* persistence is best effort */
		}
	}

	function statusLine(): string {
		if (!state.goal)
			return state.achieved ? `goal: none (last achieved: ${state.achieved})` : "goal: none";
		const elapsed = fmtElapsed(Date.now() - state.startedAt);
		const last = state.lastReason ? `\nlast: ${state.lastReason}` : "";
		return (
			`goal: ${state.goal}\nelapsed ${elapsed}, turns ${state.turns}, ` +
			`checks ${state.checks}/${MAX_CHECKS}, eval tokens ${fmtTokens(state.spentTokens)}${last}`
		);
	}

	function clearGoal() {
		state.goal = null;
		state.checks = 0;
		state.turns = 0;
		state.lastReason = null;
		state.idleTurns = 0;
		state.failures = 0;
		state.evalPending = false;
		persist();
	}

	/** Verifier model: PI_GOAL_CHECK_MODEL (provider:id or bare id) or the active model. */
	function resolveCheckModel(ctx: ExtensionContext): ExtensionContext["model"] {
		const active = ctx.model;
		if (!CHECK_MODEL) return active;
		try {
			const reg = ctx.modelRegistry;
			if (!reg) return active;
			const sep = CHECK_MODEL.indexOf(":");
			if (sep > 0) {
				const found = reg.find(CHECK_MODEL.slice(0, sep), CHECK_MODEL.slice(sep + 1));
				if (found) return found;
			} else {
				const match = reg.getAll().find((m) => m.id === CHECK_MODEL);
				if (match) return match;
			}
		} catch {
			/* fall through to the active model */
		}
		return active;
	}
	/** Verifier call. Returns null when the check must fail open (settle). */
	async function verify(
		event: TurnEndEvent | AgentBeforeSettleEvent,
		ctx: ExtensionContext,
	): Promise<{ verdict: Verdict; reason: string } | null> {
		const model = resolveCheckModel(ctx);
		const stream = ctx.modelRegistry?.streamSimple;
		if (!model || !stream) return null;
		const digest = buildDigest(event.context?.llmMessages);
		const elapsed = fmtElapsed(Date.now() - state.startedAt);
		const userText =
			`You are a goal evaluator. Judge ONLY what the transcript below demonstrates — do not assume unseen work.\n` +
			`GOAL: ${state.goal}\n` +
			`PROGRESS: turn ${state.turns + 1} of evaluation, ${state.checks} checks used of ${MAX_CHECKS} max, elapsed ${elapsed}.\n` +
			`Reply with exactly one line "VERDICT: DONE" (transcript proves the goal), ` +
			`"VERDICT: NOT_DONE" (work remains), or "VERDICT: UNREACHABLE" (can never be satisfied), ` +
			`followed by one short sentence of evidence or the next missing piece.\n` +
			`A turn/time clause in the goal ("stop after N turns") counts as a binding bound: judge it from this PROGRESS line.\n` +
			`TRANSCRIPT DIGEST (oldest first):\n${digest}`;
		let final: { content?: unknown; usage?: { input?: number; output?: number } } | undefined;
		for await (const chunk of stream(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] },
			{ reasoning: "minimal" },
		)) {
			if (chunk.type === "done") {
				final = chunk.message;
				break;
			}
		}
		const content = final?.content;
		const text = Array.isArray(content)
			? content
					.filter((b): b is { type: string; text: string } =>
						b !== null && typeof b === "object" &&
						(b as { type?: unknown }).type === "text" &&
						typeof (b as { text?: unknown }).text === "string",
					)
					.map((b) => b.text)
					.join("\n")
			: "";
		const usage = final?.usage;
		if (usage) state.spentTokens += (usage.input ?? 0) + (usage.output ?? 0);
		state.checks++;
		return parseVerdict(text);
	}

	/**
	 * Shared evaluation used by turn_end (primary) and agent_before_settle
	 * (backstop for turns that went unevaluated, e.g. deferred background
	 * turns). Mutates the event and returns the same result for callers that
	 * prefer the BoundaryResult contract.
	 */
	async function evaluate(
		event: TurnEndEvent | AgentBeforeSettleEvent,
		ctx: ExtensionContext,
	): Promise<BoundaryResult> {
		if (!state.goal) return {};
		if (event.outcome === "aborted") return {};
		if (event.outcome === "error") {
			// Turn failed: keep the goal armed, pause the loop. The next
			// user message resumes evaluation.
			ctx.ui?.notify?.(`pi-goal: turn failed — goal kept: ${state.goal}. Send a message to resume.`);
			return {};
		}
		if (event.context && event.context.canContinue === false) return {};
		if (Array.isArray(event.context?.pendingMessages) && event.context.pendingMessages.length > 0) {
			// Background work still running: defer evaluation to a later turn.
			if (!state.deferredNotice) {
				ctx.ui?.notify?.("pi-goal: background work running — evaluation deferred to a later turn.");
				state.deferredNotice = true;
			}
			return {};
		}
		state.deferredNotice = false;

		let parsed: { verdict: Verdict; reason: string } | null = null;
		try {
			parsed = await verify(event, ctx);
		} catch {
			parsed = null;
		}
		state.evalPending = false;
		if (!parsed) {
			state.failures++;
			if (state.failures >= 3) {
				ctx.ui?.notify?.(`pi-goal: goal check failed ${state.failures}x — goal paused, re-arm with /goal.`);
				clearGoal();
			} else {
				ctx.ui?.notify?.("pi-goal: goal check failed — settling (fail open).");
			}
			return {};
		}
		state.failures = 0;
		state.turns++;
		state.lastReason = parsed.reason;

		const pushEntry = (content: string) => {
			const entry: CustomMessageEntryDraft = {
				type: "custom_message",
				customType: STORE_TYPE,
				content,
				display: true,
			};
			event.entries.push(entry);
		};

		if (parsed.verdict === "DONE") {
			const doneMsg =
				`[pi-goal] ✓ Goal achieved in ${state.turns} turn(s) / ${state.checks} check(s): ${state.goal}\n` +
				`Evidence: ${parsed.reason}`;
			pushEntry(doneMsg);
			ctx.ui?.notify?.(`pi-goal: goal reached — ${state.goal}`);
			state.achieved = state.goal;
			clearGoal();
			ctx.ui?.setStatus?.("pi-goal", undefined);
			if (event.entries && event.continue !== undefined) event.continue = false;
			return { entries: event.entries, continue: false };
		}

		if (parsed.verdict === "UNREACHABLE") {
			const failMsg = `[pi-goal] ✗ Goal failed (unreachable): ${state.goal}\nBlocker: ${parsed.reason}`;
			pushEntry(failMsg);
			ctx.ui?.notify?.(`pi-goal: goal unreachable — ${parsed.reason}`);
			clearGoal();
			ctx.ui?.setStatus?.("pi-goal", undefined);
			if (event.continue !== undefined) event.continue = false;
			return { entries: event.entries, continue: false };
		}

		// NOT_DONE: stall detection first — no tool use for several turns
		// pauses the loop but KEEPS the goal; the next prompt resumes it.
		state.idleTurns = hasToolUse(event) ? 0 : state.idleTurns + 1;
		if (state.idleTurns >= STALL_TURNS) {
			state.idleTurns = 0;
			ctx.ui?.notify?.(
				`pi-goal: no progress for ${STALL_TURNS} turns (no tool use) — Paused with goal still set: ${state.goal}. Send a message to resume.`,
			);
			if (event.continue !== undefined) event.continue = false;
			return { entries: event.entries, continue: false };
		}

		if (state.checks >= MAX_CHECKS) {
			ctx.ui?.notify?.(
				`pi-goal: gave up after ${MAX_CHECKS} checks — still not done: ${state.goal}. Re-arm with /goal to continue.`,
			);
			clearGoal();
			ctx.ui?.setStatus?.("pi-goal", undefined);
			if (event.continue !== undefined) event.continue = false;
			return { entries: event.entries, continue: false };
		}

		const guidance =
			`[pi-goal] Goal not yet met (turn ${state.turns}, check ${state.checks}/${MAX_CHECKS}): ${state.goal}\n` +
			`Evaluator: ${parsed.reason}\n` +
			`Keep working toward the goal. State the verifiable outcome (test output, build exit code, file state) in your reply.`;
		pushEntry(guidance);
		if (event.continue !== undefined) event.continue = true;
		return { entries: event.entries, continue: true };
	}

	pi.on("turn_start", async () => {
		if (state.goal) state.evalPending = true;
	});

	pi.on("turn_end", async (event, ctx) => evaluate(event, ctx));

	pi.on("agent_before_settle", async (event, ctx) => {
		// Backstop: only evaluate when a turn went unevaluated (e.g. the
		// turn_end check was deferred). Never double-check an evaluated turn.
		if (!state.goal || !state.evalPending) return {};
		return evaluate(event, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i] as Partial<CustomEntry> | undefined;
				if (e?.type !== "custom" || e?.customType !== STORE_TYPE) continue;
				const data = e.data as { goal?: unknown } | null;
				if (data && typeof data.goal === "string" && data.goal.length > 0) {
					state.goal = data.goal;
					state.checks = 0;
					state.turns = 0;
					state.startedAt = Date.now();
					state.spentTokens = 0;
					state.lastReason = null;
					state.idleTurns = 0;
					state.failures = 0;
					state.evalPending = false;
					ctx.ui.notify(`pi-goal: resumed active goal — ${state.goal}`);
				}
				break; // latest pi-goal entry wins; cleared goals stay cleared
			}
		} catch {
			/* restore is best effort */
		}
	});

	pi.registerCommand("goal", {
		description: "Set a completion condition; pi keeps working across turns until a verifier confirms it",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const ui = ctx.ui;
			const text = args.trim();
			if (!text) {
				ui.notify(state.goal ? statusLine() : "goal: no goal set");
				return;
			}
			const word = text.split(/\s+/)[0].toLowerCase();
			if (CLEAR_ALIASES.has(word) && text.split(/\s+/).length === 1) {
				if (state.goal) ui.notify(`Goal cleared: ${state.goal}`);
				else ui.notify("goal: no goal set");
				clearGoal();
				ui.setStatus("pi-goal", undefined);
				return;
			}
			if (text.length > 4000) {
				ui.notify("pi-goal: condition too long (max 4000 chars).");
				return;
			}
			if (state.goal) ui.notify(`pi-goal: replacing active goal — ${state.goal}`);
			state.goal = text;
			state.checks = 0;
			state.turns = 0;
			state.startedAt = Date.now();
			state.spentTokens = 0;
			state.lastReason = null;
			state.idleTurns = 0;
			state.failures = 0;
			state.evalPending = false;
			persist();
			ui.notify(`pi-goal: goal set — ${text}`);
			ui.setStatus("pi-goal", `◎ goal: ${text.slice(0, 60)}`);
			// Setting a goal starts a turn immediately with the condition itself as the directive.
			try {
				const idle = ctx.isIdle();
				pi.sendUserMessage(
					`[pi-goal] Work toward this goal until it is verifiably met. State the verifiable outcome in your replies.\nGoal: ${text}`,
					idle ? undefined : { deliverAs: "followUp" },
				);
			} catch {
				ui.notify("pi-goal: could not start the turn — send any message to begin.");
			}
		},
	});
}
