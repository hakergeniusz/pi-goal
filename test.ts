/**
 * Spec test for pi-goal v0.2 (Claude Code /goal behavior).
 * Fake ExtensionAPI + canned verifier verdicts. No network. `bun test.ts`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const { default: activate } = await import("./index.ts");

interface Handlers {
	turnStart?: (event: unknown, ctx: unknown) => Promise<void>;
	turnEnd?: (event: unknown, ctx: unknown) => Promise<unknown>;
	settle?: (event: unknown, ctx: unknown) => Promise<void>;
	sessionStart?: (event: unknown, ctx: unknown) => Promise<void>;
	command?: { handler: (args: string, ctx: unknown) => Promise<void> };
}

interface Fake {
	pi: ExtensionAPI;
	handlers: Handlers;
	verdicts: string[];
	calls: { model: unknown; userText: string }[];
	notifications: string[];
	sent: string[];
	appended: { type: string; data: unknown }[];
	branch: unknown[];
}

function fakePi(): Fake {
	const handlers: Handlers = {};
	const fake: Fake = {
		handlers,
		verdicts: [],
		calls: [],
		notifications: [],
		sent: [],
		appended: [],
		branch: [],
		pi: {
			on: (event: string, handler: never) => {
				if (event === "turn_start") handlers.turnStart = handler as never;
				if (event === "turn_end") handlers.turnEnd = handler as never;
				if (event === "agent_before_settle") handlers.settle = handler as never;
				if (event === "session_start") handlers.sessionStart = handler as never;
				return () => {};
			},
			registerCommand: (_name: string, cmd: never) => {
				handlers.command = cmd as never;
			},
			sendUserMessage: (async (content: string) => {
				fake.sent.push(content);
			}) as never,
			appendEntry: ((type: string, data: unknown) => {
				fake.appended.push({ type, data });
			}) as never,
		} as unknown as ExtensionAPI,
	};
	return fake;
}

const TRANSCRIPT = [
	{ role: "user", content: [{ type: "text", text: "make the test pass" }] },
	{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "bun test" } }] },
	{ role: "toolResult", toolName: "bash", toolCallId: "x", content: [{ type: "text", text: "42 pass" }] },
];

const IDLE_MSG = { role: "assistant", content: [{ type: "text", text: "I think this is done." }] };
const TOOL_MSG = {
	role: "assistant",
	content: [{ type: "toolCall", name: "bash", arguments: { command: "bun test" } }],
};

function makeTurn(
	index: number,
	overrides: Partial<Record<string, unknown>> = {},
) {
	return {
		type: "turn_end",
		turnIndex: index,
		outcome: "completed",
		continue: false,
		entries: [] as unknown[],
		message: TOOL_MSG,
		toolResults: [{ toolCallId: "x" }],
		context: { canContinue: true, llmMessages: TRANSCRIPT, pendingMessages: [] },
		...overrides,
	};
}

/** Build the turn/settle context: ui + fake modelRegistry serving canned verdicts. */
function evalCtx(fake: Fake) {
	return {
		ui: {
			notify: (t: string) => fake.notifications.push(t),
			setStatus: () => {},
		},
		model: { provider: "opencode", id: "test-model" },
		modelRegistry: {
			streamSimple: (model: unknown, context: unknown) => {
				const text = fake.verdicts.shift();
				if (text === undefined) throw new Error("no canned verdict");
				fake.calls.push({
					model,
					userText: (context as { messages: { content: { text: string }[] }[] }).messages[0].content[0]
						.text,
				});
				return (async function* () {
					yield { type: "done", message: { content: [{ type: "text", text }] } };
				})() as never;
			},
		},
	};
}

function sessionCtx(fake: Fake, branch: unknown[]) {
	return {
		ui: { notify: (t: string) => fake.notifications.push(t) },
		sessionManager: { getBranch: () => branch },
	};
}

async function turn(fake: Fake, index: number, overrides?: Partial<Record<string, unknown>>) {
	const event = makeTurn(index, overrides);
	await fake.handlers.turnStart!(event, evalCtx(fake));
	const result = (await fake.handlers.turnEnd!(event, evalCtx(fake))) as unknown;
	return event as typeof event & { result: unknown; handlerResult: unknown };
}

let failures = 0;
function assert(cond: boolean, label: string) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures++;
}

function cmdCtx(fake: Fake) {
	return {
		ui: { notify: (t: string) => fake.notifications.push(t), setStatus: () => {} },
		isIdle: () => true,
	};
}

async function run() {
	// --- arming starts a turn immediately with the condition as directive ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("all tests pass", cmdCtx(fake));
		assert(fake.sent.length === 1 && fake.sent[0].includes("all tests pass"), "arm starts a turn with the condition");
		assert(fake.appended.some((e) => e.type === "pi-goal"), "arm persists goal state");
	}

	// --- status shows condition, turns, elapsed, reason ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("all tests pass", cmdCtx(fake));
		fake.notifications.length = 0;
		await fake.handlers.command!.handler("", cmdCtx(fake));
		const status = fake.notifications.join("\n");
		assert(status.includes("all tests pass"), "status shows the condition");
		assert(status.includes("turns"), "status shows turn count");
		assert(status.includes("elapsed") || status.includes("0s"), "status shows elapsed time");
	}

	// --- turn_end NOT_DONE continues with reason injected ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		assert(typeof fake.handlers.turnEnd === "function", "turn_end handler registered");
		await fake.handlers.command!.handler("add README section", cmdCtx(fake));
		fake.verdicts.push("VERDICT: NOT_DONE\nThe README section is still missing.");
		const ev = await turn(fake, 0);
		assert(ev.continue === true, "NOT_DONE at turn end continues");
		assert(ev.entries.length === 1 && (ev.entries[0] as { customType: string }).customType === "pi-goal", "continuation entry pushed");
		assert(((ev.entries[0] as { content: string }).content ?? "").includes("README section is still missing"), "reason injected");
	}

	// --- DONE records an achieved entry and clears ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("make the test pass", cmdCtx(fake));
		fake.verdicts.push("VERDICT: DONE\nThe tests pass and the file exists.");
		const ev = await turn(fake, 0);
		assert(ev.continue === false, "DONE does not continue");
		assert(ev.entries.length === 1 && ((ev.entries[0] as { content: string }).content ?? "").includes("achieved"), "DONE records achieved entry");
		assert(fake.notifications.some((n) => n.includes("goal reached")), "DONE notifies");
		await fake.handlers.command!.handler("", cmdCtx(fake));
		assert(fake.notifications.some((n) => n.includes("no goal set")), "goal cleared after DONE");
	}

	// --- stall (no tool use, several turns) pauses but KEEPS the goal ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("vague endless task", cmdCtx(fake));
		for (let i = 0; i < 3; i++)
			fake.verdicts.push(`VERDICT: NOT_DONE\nStill thinking, turn ${i}.`);
		const t0 = await turn(fake, 0, { message: IDLE_MSG, toolResults: [] });
		const t1 = await turn(fake, 1, { message: IDLE_MSG, toolResults: [] });
		assert(t0.continue === true && t1.continue === true, "first idle turns still continue");
		const t2 = await turn(fake, 2, { message: IDLE_MSG, toolResults: [] });
		assert(t2.continue === false, "third idle turn pauses the loop");
		assert(fake.notifications.some((n) => n.includes("no progress") || n.includes("Paused")), "stall warns the user");
		fake.notifications.length = 0;
		await fake.handlers.command!.handler("", cmdCtx(fake));
		assert(fake.notifications.some((n) => n.includes("vague endless task")), "goal still armed after stall");
	}

	// --- tool use resets the stall counter ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("real task", cmdCtx(fake));
		for (let i = 0; i < 4; i++) fake.verdicts.push(`VERDICT: NOT_DONE\nWorking, turn ${i}.`);
		await turn(fake, 0, { message: IDLE_MSG, toolResults: [] });
		await turn(fake, 1, { message: IDLE_MSG, toolResults: [] });
		const t2 = await turn(fake, 2); // default turn uses tools
		assert(t2.continue === true, "tool use resets stall counter");
	}

	// --- UNREACHABLE records a failed entry and clears ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("deploy to production", cmdCtx(fake));
		fake.verdicts.push("VERDICT: UNREACHABLE\nNo credentials for the deploy target.");
		const ev = await turn(fake, 0);
		assert(ev.continue === false, "UNREACHABLE settles");
		assert(ev.entries.length === 1 && ((ev.entries[0] as { content: string }).content ?? "").includes("failed"), "UNREACHABLE records failed entry");
		assert(fake.notifications.some((n) => n.includes("unreachable")), "UNREACHABLE notifies");
	}

	// --- check ceiling ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("endless task", cmdCtx(fake));
		for (let i = 0; i < 15; i++)
			fake.verdicts.push(`VERDICT: NOT_DONE\nDistinct blocker number ${i} differs each time.`);
		let ev = makeTurn(0);
		for (let i = 0; i < 13; i++) {
			const e = makeTurn(i);
			await fake.handlers.turnStart!(e, evalCtx(fake));
			await fake.handlers.turnEnd!(e, evalCtx(fake));
			ev = e;
		}
		assert(ev.continue === false, "check ceiling stops the loop (12 checks)");
		assert(fake.notifications.some((n) => n.includes("gave up after 12")), "ceiling notifies");
	}

	// --- settle backstop: no double-check after an evaluated turn ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("backstop task", cmdCtx(fake));
		fake.verdicts.push("VERDICT: NOT_DONE\nOne more thing missing.");
		const te = await turn(fake, 0);
		assert(te.continue === true, "turn_end evaluates (backstop setup)");
		const callsAfterTurn = fake.calls.length;
		const se = {
			type: "agent_before_settle",
			outcome: "completed",
			continue: false,
			entries: [] as unknown[],
			context: { canContinue: true, llmMessages: TRANSCRIPT, pendingMessages: [] },
		};
		await fake.handlers.settle!(se, evalCtx(fake));
		assert(fake.calls.length === callsAfterTurn, "settle does not re-check an evaluated turn");
		assert((se.entries as unknown[]).length === 0, "settle adds no entries after evaluated turn");
	}

	// --- background work defers evaluation ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("bg task", cmdCtx(fake));
		const ev = await turn(fake, 0, { context: { canContinue: true, llmMessages: TRANSCRIPT, pendingMessages: [{ id: "x" }] } });
		assert(fake.calls.length === 0, "no check while background work pending");
		assert(ev.continue === false, "deferred turn does not continue");
		assert(fake.notifications.some((n) => n.includes("background")), "deferral notifies");
	}

	// --- error outcome pauses, keeps the goal ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("fragile task", cmdCtx(fake));
		const ev = await turn(fake, 0, { outcome: "error" });
		assert(fake.calls.length === 0, "no check on error outcome");
		assert(ev.continue === false, "error does not continue");
		fake.notifications.length = 0;
		await fake.handlers.command!.handler("", cmdCtx(fake));
		assert(fake.notifications.some((n) => n.includes("fragile task")), "goal kept after error");
	}

	// --- aborted outcome skips silently ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("abort task", cmdCtx(fake));
		await turn(fake, 0, { outcome: "aborted" });
		assert(fake.calls.length === 0, "no check on aborted outcome");
	}

	// --- canContinue=false skips ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("anything", cmdCtx(fake));
		await turn(fake, 0, { context: { canContinue: false, llmMessages: [], pendingMessages: [] } });
		assert(fake.calls.length === 0, "canContinue=false skips the check");
	}

	// --- checker failure fails open ---
	{
		const broken = fakePi();
		await activate(broken.pi);
		await broken.handlers.command!.handler("fail-open task", cmdCtx(broken));
		const ev = await turn(broken, 0); // no canned verdicts → streamSimple throws
		assert(ev.continue === false, "checker failure does not continue");
		assert(broken.notifications.some((n) => n.includes("goal check failed")), "checker failure notifies");
	}

	// --- clear aliases ---
	{
		for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"]) {
			const fake = fakePi();
			await activate(fake.pi);
			await fake.handlers.command!.handler("temporary", cmdCtx(fake));
			fake.sent.length = 0;
			await fake.handlers.command!.handler(alias, cmdCtx(fake));
			const ev = await turn(fake, 0);
			assert(fake.calls.length === 0 && ev.continue === false, `/goal ${alias} disarms checking`);
		}
	}

	// --- resume restores an armed goal from session entries ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		assert(typeof fake.handlers.sessionStart === "function", "session_start handler registered");
		await fake.handlers.sessionStart!(
			{ type: "session_start" },
			sessionCtx(fake, [
				{ type: "custom", customType: "pi-goal", data: { goal: "saved goal", checks: 5 } },
			]),
		);
		fake.notifications.length = 0;
		await fake.handlers.command!.handler("", cmdCtx(fake));
		assert(fake.notifications.some((n) => n.includes("saved goal")), "resumed goal restored");
	}

	// --- resume ignores cleared goals ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.sessionStart!(
			{ type: "session_start" },
			sessionCtx(fake, [{ type: "custom", customType: "pi-goal", data: { goal: null } }]),
		);
		fake.notifications.length = 0;
		await fake.handlers.command!.handler("", cmdCtx(fake));
		assert(fake.notifications.some((n) => n.includes("no goal set")), "cleared goal not restored");
	}

	console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
	process.exitCode = failures === 0 ? 0 : 1;
}

await run();
