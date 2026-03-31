import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, type EditorTheme } from "@mariozechner/pi-tui";
import modalEditorExtension from "../src/index.ts";

type TestEditor = {
	handleInput: (data: string) => void;
	setText: (text: string) => void;
	getText: () => string;
	getCursor: () => { line: number; col: number };
};

type RenderableEditor = TestEditor & {
	focused: boolean;
	render: (width: number) => string[];
};

type EditorFactory = (tui: unknown, theme: EditorTheme, keybindings: unknown) => TestEditor;

type SessionStartHandler = (event: unknown, ctx: { ui: { theme: Theme; setEditorComponent: (factory: EditorFactory) => void } }) => void;

const identity = (text: string): string => text;

const editorTheme: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

const appTheme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const tuiStub = {
	requestRender: () => {},
	terminal: { rows: 24, cols: 80 },
};

const keybindingsStub = {
	matches: (_data: string, _action: string) => false,
};

function createEditor(): TestEditor {
	let onSessionStart: SessionStartHandler | undefined;
	let editorFactory: EditorFactory | undefined;

	const extensionApi = {
		on: (event: string, handler: SessionStartHandler) => {
			if (event === "session_start") {
				onSessionStart = handler;
			}
		},
	} as unknown as ExtensionAPI;

	modalEditorExtension(extensionApi);
	assert.ok(onSessionStart, "session_start handler should be registered");

	onSessionStart({}, {
		ui: {
			theme: appTheme,
			setEditorComponent: (factory) => {
				editorFactory = factory;
			},
		},
	});

	assert.ok(editorFactory, "editor factory should be registered");
	return editorFactory(tuiStub, editorTheme, keybindingsStub);
}

function press(editor: TestEditor, ...keys: string[]): void {
	for (const key of keys) {
		editor.handleInput(key);
	}
}

function getCursorAfter(text: string, ...keys: string[]): { line: number; col: number } {
	const editor = createEditor();
	editor.setText(text);
	press(editor, ...keys);
	return editor.getCursor();
}

function getTextAfter(text: string, ...keys: string[]): string {
	const editor = createEditor();
	editor.setText(text);
	press(editor, ...keys);
	return editor.getText();
}

function deleteLineRange(text: string, startLine: number, endLine: number): string {
	const lines = text.split("\n");
	const remaining = [...lines.slice(0, startLine), ...lines.slice(endLine + 1)];
	if (remaining.length === 0) {
		remaining.push("");
	}
	return remaining.join("\n");
}

function getLastOsc52ClipboardText(writes: string[]): string {
	const lastWrite = writes[writes.length - 1] ?? "";
	const match = lastWrite.match(/^\u001b\]52;[^;]*;([A-Za-z0-9+/=]+)\u0007$/);
	assert.ok(match, "expected an OSC52 clipboard write");
	return Buffer.from(match[1] ?? "", "base64").toString("utf8");
}

describe("modal-editor extension motions", () => {
	let editor: TestEditor;
	let originalWrite: typeof process.stdout.write;
	let clipboardOsc52Writes: string[];

	beforeEach(() => {
		clipboardOsc52Writes = [];
		originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
			if (text.startsWith("\u001b]52;")) {
				clipboardOsc52Writes.push(text);
				if (cb) cb(null);
				return true;
			}
			return originalWrite(chunk as never, encoding as never, cb as never);
		}) as typeof process.stdout.write;
		editor = createEditor();
	});

	afterEach(() => {
		process.stdout.write = originalWrite;
	});

	it("supports core motions h/j/k/l, 0, $, and counts", () => {
		editor.setText("one\ntwo");
		press(editor, "\x1b", "0");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });

		press(editor, "2", "l");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });

		press(editor, "$", "k");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });

		press(editor, "j", "2", "h");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });

		editor.setText("ab\ncd");
		press(editor, "9", "k", "0", "l", "l");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });

		press(editor, "h", "h");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("supports word/find motions w, b/B, e, E, f/F<char>, t/T<char>", () => {
		editor.setText("alpha beta gamma");
		press(editor, "\x1b", "0");

		press(editor, "w");
		assert.equal(editor.getCursor().col, 6);

		press(editor, "w");
		assert.equal(editor.getCursor().col, 11);

		press(editor, "b");
		assert.equal(editor.getCursor().col, 6);

		press(editor, "e");
		assert.equal(editor.getCursor().col, 9);

		press(editor, "E");
		assert.equal(editor.getCursor().col, 15);

		press(editor, "0", "f", "g");
		assert.equal(editor.getCursor().col, 11);

		press(editor, "F", "b");
		assert.equal(editor.getCursor().col, 6);

		press(editor, "T", "a");
		assert.equal(editor.getCursor().col, 5);

		press(editor, "0", "t", "g");
		assert.equal(editor.getCursor().col, 10);

		editor.setText("foo/bar baz");
		press(editor, "0", "$", "B");
		assert.equal(editor.getCursor().col, 8);

		press(editor, "B");
		assert.equal(editor.getCursor().col, 0);

		editor.setText("xabc");
		press(editor, "0", "F", "x");
		assert.equal(editor.getCursor().col, 0);
		press(editor, "T", "x");
		assert.equal(editor.getCursor().col, 0);
	});

	it("supports count with backward find motions F/T", () => {
		editor.setText("XabcXdefXghi");
		press(editor, "\x1b", "0", "$", "2", "F", "X");
		assert.equal(editor.getCursor().col, 4);

		press(editor, "0", "$", "2", "T", "X");
		assert.equal(editor.getCursor().col, 5);
	});

	it("supports missing word motions W, ge, and gE", () => {
		editor.setText("foo/bar baz qux");
		press(editor, "\x1b", "0", "W");
		assert.equal(editor.getCursor().col, 8);

		press(editor, "W");
		assert.equal(editor.getCursor().col, 12);

		press(editor, "g", "e");
		assert.equal(editor.getCursor().col, 10);

		press(editor, "g", "E");
		assert.equal(editor.getCursor().col, 6);

		editor.setText("foo/bar baz qux");
		press(editor, "0", "2", "W");
		assert.equal(editor.getCursor().col, 12);
	});

	it("supports find follow-ups with ; and , in normal and operator-pending modes", () => {
		editor.setText("abXcdXefXgh");
		press(editor, "\x1b", "0", "f", "X", ";", ";");
		assert.equal(editor.getCursor().col, 8);

		press(editor, ",", ",");
		assert.equal(editor.getCursor().col, 2);

		editor.setText("abXcdXefXgh");
		press(editor, "0", "f", "X", ";", "d", ";");
		assert.equal(editor.getText(), "abXcdgh");
	});

	it("supports structural motions %, (, ), {, }", () => {
		editor.setText("(abc(def)ghi)");
		press(editor, "\x1b", "0", "%");
		assert.equal(editor.getCursor().col, 12);
		press(editor, "%");
		assert.equal(editor.getCursor().col, 0);

		editor.setText("One. Two! Three?");
		press(editor, "0", ")");
		assert.equal(editor.getCursor().col, 5);
		press(editor, ")");
		assert.equal(editor.getCursor().col, 10);
		press(editor, "(");
		assert.equal(editor.getCursor().col, 5);

		editor.setText("one\ntwo\n\nthree\nfour\n\nfive");
		press(editor, "9", "k", "0", "}");
		assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
		press(editor, "}");
		assert.deepEqual(editor.getCursor(), { line: 5, col: 0 });

		editor.setText("one\ntwo\n\nthree\nfour\n\nfive");
		press(editor, "9", "k", "0", "}", "j", "{");
		assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
	});

	it("supports absolute line motions gg and G", () => {
		editor.setText("  one\n   two\nthree\n  four");
		press(editor, "\x1b", "9", "k", "0", "G");
		assert.deepEqual(editor.getCursor(), { line: 3, col: 2 });

		press(editor, "g", "g");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });

		press(editor, "3", "G");
		assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });

		press(editor, "2", "g", "g");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 3 });

		editor.setText("   solo");
		press(editor, "0", "G");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
	});

	it("supports G and gg in visual line mode", () => {
		editor.setText("a\nb\nc\nd");
		press(editor, "\x1b", "9", "k", "0", "j", "V", "G", "d");
		assert.equal(editor.getText(), "a");

		editor.setText("a\nb\nc\nd");
		press(editor, "\x1b", "9", "k", "0", "j", "j", "V", "g", "g", "d");
		assert.equal(editor.getText(), "d");

		editor.setText("a\nb\nc\nd\ne");
		press(editor, "\x1b", "9", "k", "0", "V", "3", "G", "d");
		assert.equal(editor.getText(), "d\ne");
	});

	it("supports dG and dgg as linewise motions", () => {
		editor.setText("a\nb\nc\nd");
		press(editor, "\x1b", "9", "k", "0", "j", "d", "G");
		assert.equal(editor.getText(), "a");

		editor.setText("a\nb\nc\nd");
		press(editor, "\x1b", "9", "k", "0", "j", "j", "d", "g", "g");
		assert.equal(editor.getText(), "d");

		editor.setText("a\nb\nc");
		press(editor, "\x1b", "G", "d", "G");
		assert.equal(editor.getText(), "a\nb");

		editor.setText("a");
		press(editor, "\x1b", "0", "d", "G");
		assert.equal(editor.getText(), "");
	});

	it("keeps supported motions aligned between normal mode and visual-line mode", () => {
		const cases: Array<{ text: string; setup: string[]; motion: string[] }> = [
			{ text: "abcd", setup: ["\x1b", "0", "2", "l"], motion: ["h"] },
			{ text: "one\ntwo\nthree", setup: ["\x1b", "9", "k", "0"], motion: ["j"] },
			{ text: "one\ntwo\nthree", setup: ["\x1b", "j", "0"], motion: ["k"] },
			{ text: "abcd", setup: ["\x1b", "0"], motion: ["2", "l"] },
			{ text: "alpha beta", setup: ["\x1b", "0", "$"], motion: ["0"] },
			{ text: "alpha beta", setup: ["\x1b", "0"], motion: ["$"] },
			{ text: "alpha beta gamma", setup: ["\x1b", "0"], motion: ["w"] },
			{ text: "foo/bar baz qux", setup: ["\x1b", "0"], motion: ["2", "W"] },
			{ text: "alpha beta gamma", setup: ["\x1b", "0", "$"], motion: ["b"] },
			{ text: "foo/bar baz", setup: ["\x1b", "0", "$"], motion: ["B"] },
			{ text: "alpha beta gamma", setup: ["\x1b", "0"], motion: ["E"] },
			{ text: "foo/bar baz qux", setup: ["\x1b", "0", "2", "W"], motion: ["g", "e"] },
			{ text: "foo/bar baz qux", setup: ["\x1b", "0", "2", "W"], motion: ["g", "E"] },
			{ text: "abXcdXefXgh", setup: ["\x1b", "0"], motion: ["f", "X"] },
			{ text: "abXcdXefXgh", setup: ["\x1b", "0"], motion: ["f", "X", ";"] },
			{ text: "abXcdXefXgh", setup: ["\x1b", "$"], motion: ["F", "X"] },
			{ text: "abXcdXefXgh", setup: ["\x1b", "$"], motion: ["T", "X"] },
			{ text: "abXcdXefXgh", setup: ["\x1b", "0"], motion: ["t", "X"] },
			{ text: "abXcdXefXgh", setup: ["\x1b", "0"], motion: ["f", "X", ","] },
			{ text: "(abc(def)ghi)", setup: ["\x1b", "0"], motion: ["%"] },
			{ text: "One. Two! Three?", setup: ["\x1b", "0"], motion: [")"] },
			{ text: "One. Two! Three?", setup: ["\x1b", "0", ")", ")"], motion: ["("] },
			{ text: "one\ntwo\n\nthree\nfour\n\nfive", setup: ["\x1b", "9", "k", "0"], motion: ["}"] },
			{ text: "one\ntwo\n\nthree\nfour\n\nfive", setup: ["\x1b", "9", "k", "0", "}", "j"], motion: ["{"] },
			{ text: "one\ntwo\nthree\nfour", setup: ["\x1b", "9", "k", "0"], motion: ["G"] },
			{ text: "one\ntwo\nthree\nfour", setup: ["\x1b", "G"], motion: ["g", "g"] },
			{ text: "one\ntwo\nthree\nfour", setup: ["\x1b", "G"], motion: ["3", "g", "g"] },
			{ text: "one\ntwo\nthree\nfour", setup: ["\x1b", "9", "k", "0"], motion: ["3", "G"] },
		];

		for (const { text, setup, motion } of cases) {
			const normalCursor = getCursorAfter(text, ...setup, ...motion);
			const visualLineCursor = getCursorAfter(text, ...setup, "V", ...motion);
			assert.deepEqual(visualLineCursor, normalCursor, `visual-line motion ${motion.join("")} should match normal mode`);
		}
	});

	it("applies supported visual-line motions as linewise selections", () => {
		const cases: Array<{ text: string; setup: string[]; motion: string[] }> = [
			{ text: "a\nb\nc", setup: ["\x1b", "9", "k", "0"], motion: ["j"] },
			{ text: "a\nb\nc\nd", setup: ["\x1b", "9", "k", "0"], motion: ["2", "j"] },
			{ text: "a\nb\nc", setup: ["\x1b", "G", "0"], motion: ["k"] },
			{ text: "a\nb\nc\nd", setup: ["\x1b", "9", "k", "0", "j"], motion: ["G"] },
			{ text: "a\nb\nc\nd", setup: ["\x1b", "G", "0", "k"], motion: ["g", "g"] },
			{ text: "a\nb\nc\nd\ne", setup: ["\x1b", "9", "k", "0"], motion: ["3", "G"] },
			{ text: "one\ntwo\n\nthree\nfour\n\nfive", setup: ["\x1b", "9", "k", "0"], motion: ["}"] },
			{ text: "one\ntwo\n\nthree\nfour\n\nfive", setup: ["\x1b", "9", "k", "0", "}", "j"], motion: ["{"] },
			{ text: "one two\nthree four", setup: ["\x1b", "9", "k", "0"], motion: ["3", "W"] },
			{ text: "(\nabc\n)", setup: ["\x1b", "9", "k", "0"], motion: ["%"] },
		];

		for (const { text, setup, motion } of cases) {
			const startCursor = getCursorAfter(text, ...setup);
			const endCursor = getCursorAfter(text, ...setup, ...motion);
			const expected = deleteLineRange(text, Math.min(startCursor.line, endCursor.line), Math.max(startCursor.line, endCursor.line));
			const visualDeleted = getTextAfter(text, ...setup, "V", ...motion, "d");
			assert.equal(visualDeleted, expected, `V${motion.join("")}d should delete the selected line range`);
		}
	});

	it("supports new motions in visual mode", () => {
		editor.setText("foo/bar baz");
		press(editor, "\x1b", "0", "v", "W");
		assert.equal(editor.getCursor().col, 8);

		press(editor, "\x1b");
		editor.setText("abXcdXefXgh");
		press(editor, "0", "v", "f", "X", ";");
		assert.equal(editor.getCursor().col, 5);
	});

	it("supports backward find when Shift+F is sent as a Kitty sequence", () => {
		editor.setText("alpha beta gamma");
		press(editor, "\x1b", "0", "$", "\x1b[102;2u", "b");
		assert.equal(editor.getCursor().col, 6);
	});

	it("supports Shift+T and shifted find targets from Kitty sequences", () => {
		editor.setText("abXcdXef");
		press(editor, "\x1b", "0", "$", "\x1b[116;2u", "\x1b[120;2u");
		assert.equal(editor.getCursor().col, 6);
	});

	it("supports Shift+F/Shift+T when Kitty sends uppercase codepoint CSI-u keys", () => {
		editor.setText("abXcdXef");
		press(editor, "\x1b", "0", "$", "\x1b[70;2u", "X");
		assert.equal(editor.getCursor().col, 5);

		press(editor, "\x1b", "0", "$", "\x1b[84;2u", "X");
		assert.equal(editor.getCursor().col, 6);
	});

	it("supports uppercase CSI-u find targets in pending find mode", () => {
		editor.setText("abXcdXef");
		press(editor, "\x1b", "0", "$", "F", "\x1b[88;2u");
		assert.equal(editor.getCursor().col, 5);
	});

	it("supports visual-line entry via Kitty Shift+V CSI-u variants", () => {
		editor.setText("a\nb\nc");
		press(editor, "\x1b", "9", "k", "0", "\x1b[118;2u", "j", "d");
		assert.equal(editor.getText(), "c");

		editor.setText("a\nb\nc");
		press(editor, "9", "k", "0", "\x1b[86;2u", "j", "d");
		assert.equal(editor.getText(), "c");
	});

	it("supports uppercase CSI-u variants for U/Y/E commands", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "x", "u", "\x1b[85;2u");
		assert.equal(editor.getText(), "bcdef");

		editor.setText("a\nb");
		press(editor, "\x1b", "9", "k", "0", "\x1b[89;2u", "p");
		assert.equal(editor.getText(), "a\na\nb");

		editor.setText("alpha beta gamma");
		press(editor, "\x1b", "9", "k", "0", "\x1b[69;2u");
		assert.equal(editor.getCursor().col, 4);
	});

	it("supports uppercase normal-mode commands from Kitty shift sequences", () => {
		editor.setText("foo/bar baz");
		press(editor, "\x1b", "0", "$", "\x1b[98;2u");
		assert.equal(editor.getCursor().col, 8);

		editor.setText("abcdef");
		press(editor, "0", "3", "l", "\x1b[100;2u");
		assert.equal(editor.getText(), "abc");

		editor.setText("  abc");
		press(editor, "0", "\x1b[105;2u", "X", "\x1b");
		assert.equal(editor.getText(), "  Xabc");

		editor.setText("abc");
		press(editor, "0", "\x1b[97;2u", "X", "\x1b");
		assert.equal(editor.getText(), "abcX");

		editor.setText("a\nb");
		press(editor, "0", "\x1b[111;2u", "X", "\x1b");
		assert.equal(editor.getText(), "a\nX\nb");

		editor.setText("hello\nworld");
		press(editor, "\x1b", "k", "\x1b[106;2u");
		assert.equal(editor.getText(), "hello world");
	});

	it("supports Shift+B from Kitty sequences in visual and delete-operator motions", () => {
		editor.setText("foo/bar baz");
		press(editor, "\x1b", "0", "v", "$", "\x1b[98;2u");
		assert.equal(editor.getCursor().col, 8);

		press(editor, "\x1b");
		editor.setText("foo/bar baz");
		press(editor, "0", "$", "d", "\x1b[98;2u");
		assert.equal(editor.getText(), "foo/bar z");
	});

	it("supports B across line boundaries", () => {
		editor.setText("one two\nthree four");
		press(editor, "\x1b", "0", "B");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
	});

	it("supports count with delete motion", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "3", "l", "4", "x");
		assert.equal(editor.getText(), "abc");
	});

	it("supports single-character replace with r<char>", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "2", "l", "r", "X");
		assert.equal(editor.getText(), "abXdef");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });

		press(editor, "u");
		assert.equal(editor.getText(), "abcdef");

		press(editor, "U");
		assert.equal(editor.getText(), "abXdef");

		editor.setText("abcdef");
		press(editor, "0", "2", "l", "3", "r", "X");
		assert.equal(editor.getText(), "abXXXf");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });

		editor.setText("abcdef");
		press(editor, "0", "1", "0", "r", "X");
		assert.equal(editor.getText(), "abcdef");

		editor.setText("abcdef");
		press(editor, "0", "r", "5");
		assert.equal(editor.getText(), "5bcdef");

		editor.setText("");
		press(editor, "0", "r", "X");
		assert.equal(editor.getText(), "");

		editor.setText("abc\ndef");
		press(editor, "9", "k", "0", "2", "l", "r", "X");
		assert.equal(editor.getText(), "abX\ndef");

		editor.setText("abcdef");
		press(editor, "0", "$", "r", "X");
		assert.equal(editor.getText(), "abcdeX");

		editor.setText("abcdef");
		press(editor, "0", "3", "r", "\x1b");
		assert.equal(editor.getText(), "abcdef");
	});

	it("copies deleted text to the clipboard for x and delete motions", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "2", "l", "x");
		assert.equal(getLastOsc52ClipboardText(clipboardOsc52Writes), "c");

		editor.setText("alpha beta");
		press(editor, "\x1b", "0", "d", "w");
		assert.equal(getLastOsc52ClipboardText(clipboardOsc52Writes), "alpha ");

		editor.setText("a\nb\nc");
		press(editor, "\x1b", "9", "k", "0", "d", "j");
		assert.equal(getLastOsc52ClipboardText(clipboardOsc52Writes), "a\nb");
	});

	it("handles Shift+E in visual mode", () => {
		editor.setText("alpha beta gamma");
		press(editor, "\x1b", "0", "v");
		const before = editor.getCursor().col;
		press(editor, "E");
		assert.ok(editor.getCursor().col > before);
	});

	it("supports B/F/T motions in visual mode", () => {
		editor.setText("alpha beta gamma");
		press(editor, "\x1b", "0", "v", "$", "F", "b");
		assert.equal(editor.getCursor().col, 6);

		press(editor, "T", "a");
		assert.equal(editor.getCursor().col, 5);

		editor.setText("foo/bar baz");
		press(editor, "0", "v", "$", "B");
		assert.equal(editor.getCursor().col, 8);
	});

	it("emits OSC52 clipboard data when yanking in visual mode", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "v", "2", "l", "y");

		assert.ok(clipboardOsc52Writes.length > 0);
		const lastWrite = clipboardOsc52Writes[clipboardOsc52Writes.length - 1] ?? "";
		const match = lastWrite.match(/^\u001b\]52;[^;]*;([A-Za-z0-9+/=]+)\u0007$/);
		assert.ok(match);
		assert.equal(Buffer.from(match[1] ?? "", "base64").toString("utf8"), "abc");
	});

	it("copies visual selection with y and pastes with p", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "v", "2", "l", "y", "$", "p");
		assert.equal(editor.getText(), "abcdefabc");

		editor.setText("abc\ndef");
		press(editor, "9", "k", "0", "v", "$", "y", "p");
		assert.equal(editor.getText(), "abcabc\ndef");
	});

	it("replaces visual selection when pasting in visual mode", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "v", "2", "l", "y");
		press(editor, "0", "v", "1", "l", "p");
		assert.equal(editor.getText(), "abccdef");
	});

	it("supports visual line mode with V and linewise delete", () => {
		editor.setText("a\nb\nc\nd");
		press(editor, "\x1b", "2", "k", "0", "V", "j", "d");
		assert.equal(editor.getText(), "a\nd");

		editor.setText("ab\ncd");
		press(editor, "k", "0", "V", "v", "d");
		assert.equal(editor.getText(), "b\ncd");
	});

	it("supports visual line yank and paste-over replacement", () => {
		editor.setText("a\nb\nc\nd");
		press(editor, "\x1b", "2", "k", "0", "V", "j", "y");
		press(editor, "9", "k", "0", "V", "p");
		assert.equal(editor.getText(), "b\nc\nb\nc\nd");
	});

	it("uses linewise paste semantics for normal-mode p after line yanks", () => {
		editor.setText("a\nb\nc");
		press(editor, "\x1b", "2", "k", "0", "y", "y", "p");
		assert.equal(editor.getText(), "a\na\nb\nc");

		editor.setText("a\nb\nc\nd");
		press(editor, "2", "k", "0", "V", "j", "y", "9", "k", "0", "p");
		assert.equal(editor.getText(), "a\nb\nc\nb\nc\nd");
	});

	it("emits a cursor marker in visual mode so resize redraws keep cursor row in sync", () => {
		editor.setText("alpha beta gamma");
		press(editor, "\x1b", "0", "v");

		const renderable = editor as RenderableEditor;
		renderable.focused = true;
		const lines = renderable.render(40);
		assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
	});

	it("uses resized wrap width for visual-mode vertical movement", () => {
		editor.setText("12345678901234567890");
		press(editor, "\x1b", "v");

		const renderable = editor as RenderableEditor;
		renderable.focused = true;
		renderable.render(10); // simulate narrow terminal resize

		press(editor, "k");
		assert.notEqual(editor.getCursor().col, 0);
	});

	it("opens a line above with O and enters insert mode on the new blank line", () => {
		editor.setText("a\nb");
		press(editor, "\x1b", "0", "O", "X", "\x1b");
		assert.equal(editor.getText(), "a\nX\nb");
	});

	it("supports d with b/B and f/F/t/T motions, including count composition", () => {
		editor.setText("abcgxgyz");
		press(editor, "\x1b", "0", "2", "d", "f", "g");
		assert.equal(editor.getText(), "yz");

		editor.setText("abcXdefXghi");
		press(editor, "\x1b", "0", "$", "2", "d", "F", "X");
		assert.equal(editor.getText(), "abc");

		editor.setText("abcXdefXghi");
		press(editor, "\x1b", "0", "$", "d", "T", "X");
		assert.equal(editor.getText(), "abcXdefX");

		editor.setText("foo/bar baz");
		press(editor, "\x1b", "0", "$", "d", "B");
		assert.equal(editor.getText(), "foo/bar z");

		editor.setText("foo/bar baz");
		press(editor, "\x1b", "0", "9", "l", "d", "B");
		assert.equal(editor.getText(), "foo/bar az");

		editor.setText("aa bb cc dd");
		press(editor, "\x1b", "0", "$", "2", "d", "B");
		assert.equal(editor.getText(), "aa bb d");

		editor.setText("xabc");
		press(editor, "\x1b", "0", "d", "F", "x");
		assert.equal(editor.getText(), "xabc");
	});

	it("joins lines with a separating space on J", () => {
		editor.setText("hello\nworld");
		press(editor, "\x1b", "k", "J");
		assert.equal(editor.getText(), "hello world");
	});

	it("deletes only the empty current line for dd", () => {
		editor.setText("a\n\nb\nc");
		press(editor, "\x1b", "k", "k", "d", "d");
		assert.equal(editor.getText(), "a\nb\nc");
	});

	it("supports common delete motions d$, d0, dh, dj, dk", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "3", "l", "d", "$");
		assert.equal(editor.getText(), "abc");

		editor.setText("abcdef");
		press(editor, "\x1b", "0", "4", "l", "d", "0");
		assert.equal(editor.getText(), "ef");

		editor.setText("abcdef");
		press(editor, "\x1b", "0", "4", "l", "d", "h");
		assert.equal(editor.getText(), "abcef");

		editor.setText("a\nb\nc\nd");
		press(editor, "\x1b", "k", "k", "d", "j");
		assert.equal(editor.getText(), "a\nd");

		editor.setText("a\nb\nc\nd");
		press(editor, "\x1b", "k", "d", "k");
		assert.equal(editor.getText(), "a\nd");
	});

	it("supports change operator basics c$, cc, cw, cG, and cgg", () => {
		editor.setText("abc def");
		press(editor, "\x1b", "9", "k", "0", "4", "l", "c", "$", "X", "\x1b");
		assert.equal(editor.getText(), "abc X");

		editor.setText("a\nb\nc");
		press(editor, "9", "k", "0", "j", "c", "c", "X", "\x1b");
		assert.equal(editor.getText(), "a\nX\nc");

		editor.setText("word next");
		press(editor, "9", "k", "0", "c", "w", "X", "\x1b");
		assert.equal(editor.getText(), "X next");

		editor.setText("a\nb\nc");
		press(editor, "9", "k", "0", "c", "G", "X", "\x1b");
		assert.equal(editor.getText(), "X");

		editor.setText("a\nb\nc");
		press(editor, "G", "c", "g", "g", "X", "\x1b");
		assert.equal(editor.getText(), "X");
	});

	it("supports operator-pending yank motions", () => {
		editor.setText("a\nb\nc");
		press(editor, "\x1b", "9", "k", "0", "y", "y", "p");
		assert.equal(editor.getText(), "a\na\nb\nc");

		editor.setText("a\nb\nc");
		press(editor, "9", "k", "0", "y", "j", "p");
		assert.equal(editor.getText(), "a\na\nb\nb\nc");

		editor.setText("a\nb\nc\nd");
		press(editor, "9", "k", "0", "j", "y", "G", "p");
		assert.equal(editor.getText(), "a\nb\nb\nc\nd\nc\nd");

		editor.setText("a\nb\nc\nd");
		press(editor, "G", "y", "g", "g", "p");
		assert.equal(editor.getText(), "a\nb\nc\nd\na\nb\nc\nd");
	});

	it("supports indent and outdent operators", () => {
		editor.setText("a\nb\nc");
		press(editor, "\x1b", "9", "k", "0", ">", ">");
		assert.equal(editor.getText(), "  a\nb\nc");

		press(editor, "<", "<");
		assert.equal(editor.getText(), "a\nb\nc");

		press(editor, ">", "j");
		assert.equal(editor.getText(), "  a\n  b\nc");
	});

	it("supports g~ / gu / gU operators", () => {
		editor.setText("abc def");
		press(editor, "\x1b", "9", "k", "0", "g", "U", "w");
		assert.equal(editor.getText(), "ABC def");

		press(editor, "9", "k", "0", "g", "u", "w");
		assert.equal(editor.getText(), "abc def");

		press(editor, "9", "k", "0", "g", "~", "w");
		assert.equal(editor.getText(), "ABC def");
	});

	it("supports text objects iw/aw for c/d/y and case operators", () => {
		editor.setText("one two three");
		press(editor, "\x1b", "9", "k", "0", "c", "i", "w", "X", "\x1b");
		assert.equal(editor.getText(), "X two three");

		editor.setText("one two three");
		press(editor, "9", "k", "0", "d", "a", "w");
		assert.equal(editor.getText(), "two three");

		editor.setText("one two");
		press(editor, "9", "k", "0", "y", "i", "w", "$", "p");
		assert.equal(editor.getText(), "one twoone");

		editor.setText("one two");
		press(editor, "9", "k", "0", "g", "U", "i", "w");
		assert.equal(editor.getText(), "ONE two");
	});

	it("supports quote and delimiter text objects", () => {
		editor.setText('say "hello" world');
		press(editor, "\x1b", "9", "k", "0", "f", "h", "c", "i", '"', "X", "\x1b");
		assert.equal(editor.getText(), 'say "X" world');

		editor.setText("(abc) def");
		press(editor, "9", "k", "0", "y", "i", ")", "$", "p");
		assert.equal(editor.getText(), "(abc) defabc");

		editor.setText("x[ab]y");
		press(editor, "9", "k", "0", "f", "b", "d", "a", "]");
		assert.equal(editor.getText(), "xy");

		editor.setText("{ab} cd");
		press(editor, "9", "k", "0", "g", "U", "i", "{");
		assert.equal(editor.getText(), "{AB} cd");
	});

	it("places the visual-mode cursor marker at the actual cursor column", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "3", "l", "v");

		const renderable = editor as RenderableEditor;
		renderable.focused = true;
		const lines = renderable.render(20);
		const markerLine = lines.find((line) => line.includes(CURSOR_MARKER));
		assert.ok(markerLine);
		assert.ok(markerLine.indexOf(CURSOR_MARKER) > 0);
	});

	it("returns to the expected normal-mode cursor when leaving insert mode", () => {
		assert.deepEqual(getCursorAfter("", "a", "b", "c", "\x1b"), { line: 0, col: 2 });
		assert.deepEqual(getCursorAfter("abc", "\x1b", "0", "l", "i", "\x1b"), { line: 0, col: 1 });
		assert.deepEqual(getCursorAfter("abc", "\x1b", "0", "l", "a", "\x1b"), { line: 0, col: 1 });
		assert.deepEqual(getCursorAfter("abc", "\x1b", "0", "A", "\x1b"), { line: 0, col: 2 });
	});

	it("keeps undo cursor positions sensible after insert edits", () => {
		editor.setText("");
		press(editor, "a", "b", "c", "\x1b", "u");
		assert.equal(editor.getText(), "ab");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
	});

	it("supports undo/redo with u and U", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "x");
		assert.equal(editor.getText(), "bcdef");

		press(editor, "u");
		assert.equal(editor.getText(), "abcdef");

		press(editor, "U");
		assert.equal(editor.getText(), "bcdef");
	});
});
