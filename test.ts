/**
 * Smoke test: runs index.ts against a fake ExtensionAPI and a fake
 * modelRegistry.streamSimple that returns canned verdicts. No network,
 * no real model. `bun test.ts`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const { default: activate } = await import("./index.ts");

interface Handlers {
	settle?: (event: unknown, ctx: unknown) => Promise<void>;
	command?: { handler: (args: string, ctx: unknown) => Promise<void> };
}

interface Fake {
	pi: ExtensionAPI;
	handlers: Handlers;
	verdicts: string[];
	calls: { model: unknown; userText: string }[];
	notifications: string[];
}

function fakePi(): Fake {
	const handlers: Handlers = {};
	const fake: Fake = {
		handlers,
		verdicts: [],
		calls: [],
		notifications: [],
		pi: {
			on: (event: string, handler: never) => {
				if (event === "agent_before_settle") handlers.settle = handler as never;
				return () => {};
			},
			registerCommand: (_name: string, cmd: never) => {
				handlers.command = cmd as never;
			},
		} as unknown as ExtensionAPI,
	};
	return fake;
}

function makeSettle(overrides: Partial<Record<string, unknown>> = {}, transcript: unknown[] = []) {
	return {
		type: "agent_before_settle",
		outcome: "completed",
		continue: false,
		entries: [] as unknown[],
		context: { canContinue: true, llmMessages: transcript },
		...overrides,
	};
}

const TRANSCRIPT = [
	{ role: "user", content: [{ type: "text", text: "make the test pass" }] },
	{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "bun test" } }] },
	{ role: "toolResult", toolName: "bash", toolCallId: "x", content: [{ type: "text", text: "42 pass" }] },
];

/** Build the settle-context: ui + fake modelRegistry serving canned verdicts. */
function settleCtx(fake: Fake) {
	return {
		ui: { notify: (t: string) => fake.notifications.push(t) },
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

async function settle(fake: Fake, overrides?: Partial<Record<string, unknown>>, transcript?: unknown[]) {
	const event = makeSettle(overrides, transcript);
	await fake.handlers.settle!(event, settleCtx(fake));
	return event as {
		continue: boolean;
		entries: { content?: string; customType?: string; display?: boolean }[];
	};
}

let failures = 0;
function assert(cond: boolean, label: string) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures++;
}

async function run() {
	// --- DONE verdict: verify, notify, clear ---
	{
		const fake = fakePi();
		fake.verdicts.push("VERDICT: DONE\nThe tests pass and the file exists.");
		await activate(fake.pi);
		await fake.handlers.command!.handler("make the test pass", commandCtx(fake));

		const aborted = await settle(fake, { outcome: "aborted" }, TRANSCRIPT);
		assert(fake.calls.length === 0 && aborted.continue === false, "no check on aborted outcome");

		const ev = await settle(fake, {}, TRANSCRIPT);
		assert(fake.calls.length === 1, "verifier called once when goal armed");
		assert(fake.calls[0].userText.includes("GOAL: make the test pass"), "verifier prompt contains the goal");
		assert(fake.calls[0].userText.includes("bun test"), "verifier prompt contains transcript digest");
		assert(fake.calls[0].userText.length < 11_000, "digest respects size cap");
		assert(ev.continue === false && ev.entries.length === 0, "DONE settles without continuation");
		assert(fake.notifications.some((n) => n.includes("goal reached")), "DONE notifies the user");
		await fake.handlers.command!.handler("", commandCtx(fake));
		assert(fake.notifications.some((n) => n.includes("no goal set")), "goal cleared after DONE");
	}

	// --- NOT_DONE → continuation with the reason injected ---
	{
		const fake = fakePi();
		fake.verdicts.push("VERDICT: NOT_DONE\nThe README section is still missing.");
		await activate(fake.pi);
		await fake.handlers.command!.handler("add README section", commandCtx(fake));
		const ev = await settle(fake);
		assert(ev.continue === true, "NOT_DONE continues the run");
		assert(ev.entries.length === 1 && ev.entries[0].customType === "pi-goal", "continuation entry pushed");
		assert(
			(ev.entries[0].content ?? "").includes("README section is still missing"),
			"verifier reason injected into continuation message",
		);
		assert(ev.entries[0].display === true, "continuation message is visible");
	}

	// --- same blocker twice → no-progress stop, goal cleared ---
	{
		const fake = fakePi();
		const reason = "Needs root access to the hosts file.";
		fake.verdicts.push(`VERDICT: NOT_DONE\n${reason}`, `VERDICT: NOT_DONE\n${reason}`);
		await activate(fake.pi);
		await fake.handlers.command!.handler("edit system hosts file", commandCtx(fake));
		await settle(fake);
		const second = await settle(fake);
		assert(second.continue === false, "same blocker twice stops continuation");
		assert(fake.notifications.some((n) => n.includes("no progress")), "no-progress detection notifies");
		await fake.handlers.command!.handler("", commandCtx(fake));
		assert(fake.notifications.some((n) => n.includes("no goal set")), "goal cleared on no-progress");
	}

	// --- UNREACHABLE → cleared ---
	{
		const fake = fakePi();
		fake.verdicts.push("VERDICT: UNREACHABLE\nNo credentials for the deploy target.");
		await activate(fake.pi);
		await fake.handlers.command!.handler("deploy to production", commandCtx(fake));
		const ev = await settle(fake);
		assert(ev.continue === false, "UNREACHABLE settles");
		assert(fake.notifications.some((n) => n.includes("unreachable")), "UNREACHABLE notifies with blocker");
	}

	// --- check ceiling ---
	{
		const fake = fakePi();
		for (let i = 0; i < 15; i++)
			fake.verdicts.push(`VERDICT: NOT_DONE\nDistinct blocker number ${i} differs each time.`);
		await activate(fake.pi);
		await fake.handlers.command!.handler("endless task", commandCtx(fake));
		let ev = { continue: true };
		for (let i = 0; i < 13; i++) ev = await settle(fake);
		assert(ev.continue === false, "check ceiling stops the loop (12 checks)");
		assert(fake.notifications.some((n) => n.includes("gave up after 12")), "ceiling notifies");
	}

	// --- canContinue=false respected; checker failure fails open ---
	{
		const fake = fakePi();
		fake.verdicts.push("VERDICT: DONE\nok");
		await activate(fake.pi);
		await fake.handlers.command!.handler("anything", commandCtx(fake));
		await settle(fake, { context: { canContinue: false, llmMessages: [] } });
		assert(fake.calls.length === 0, "canContinue=false skips the check");

		const broken = fakePi();
		await activate(broken.pi);
		await broken.handlers.command!.handler("fail-open task", commandCtx(fake));
		const ev = await settle(broken); // no canned verdicts → streamSimple throws
		assert(ev.continue === false, "checker failure settles normally");
		assert(broken.notifications.some((n) => n.includes("goal check failed")), "checker failure notifies");
	}

	// --- /goal clear ---
	{
		const fake = fakePi();
		await activate(fake.pi);
		await fake.handlers.command!.handler("temporary", commandCtx(fake));
		await fake.handlers.command!.handler("clear", commandCtx(fake));
		const ev = await settle(fake);
		assert(fake.calls.length === 0 && ev.continue === false, "/goal clear disarms checking");
	}

	console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

function cmdCtx() {
	return { ui: { notify: () => {} } };
}

function commandCtx(fake: Fake) {
	return { ui: { notify: (t: string) => fake.notifications.push(t) } };
}

await run();
