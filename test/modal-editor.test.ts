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

describe("modal-editor extension motions", () => {
	let editor: TestEditor;
	let originalWrite: typeof process.stdout.write;

	beforeEach(() => {
		originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
			if (text.startsWith("\u001b]52;")) {
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
		assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });

		press(editor, "j", "2", "h");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 1 });
	});

	it("supports word/find motions w, b, e, E, f<char>, t<char>", () => {
		editor.setText("alpha beta gamma");
		press(editor, "\x1b", "0");

		press(editor, "w");
		assert.equal(editor.getCursor().col, 5);

		press(editor, "w");
		assert.equal(editor.getCursor().col, 10);

		press(editor, "b");
		assert.equal(editor.getCursor().col, 6);

		press(editor, "e");
		assert.equal(editor.getCursor().col, 10);

		press(editor, "E");
		assert.equal(editor.getCursor().col, 16);

		press(editor, "0", "f", "g");
		assert.equal(editor.getCursor().col, 11);

		press(editor, "0", "t", "g");
		assert.equal(editor.getCursor().col, 10);
	});

	it("supports count with delete motion", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "3", "l", "4", "x");
		assert.equal(editor.getText(), "abc");
	});

	it("handles Shift+E in visual mode", () => {
		editor.setText("alpha beta gamma");
		press(editor, "\x1b", "0", "v");
		const before = editor.getCursor().col;
		press(editor, "E");
		assert.ok(editor.getCursor().col > before);
	});

	it("copies visual selection with y and pastes with p", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "v", "2", "l", "y", "$", "p");
		assert.equal(editor.getText(), "abcdefabc");
	});

	it("replaces visual selection when pasting in visual mode", () => {
		editor.setText("abcdef");
		press(editor, "\x1b", "0", "v", "2", "l", "y");
		press(editor, "0", "v", "1", "l", "p");
		assert.equal(editor.getText(), "abccdef");
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

	it("combines operator and motion counts for d f/t motions", () => {
		editor.setText("abcgxgyz");
		press(editor, "\x1b", "0", "2", "d", "f", "g");
		assert.equal(editor.getText(), "yz");
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
