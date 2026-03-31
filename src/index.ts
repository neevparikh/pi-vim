/**
 * Modal Editor - vim-like modal editing extension
 *
 * - Escape: insert -> normal mode (in normal mode, aborts agent when no pending command)
 * - Modes: normal, insert, visual, visual-line
 * - Counts: e.g. 2l, 3w, 2dd
 * - Motions: h j k l, 0, $, w/W, b/B, e/E, ge/gE, f/F<char>, t/T<char>, ;/,, %,(,),{,}
 * - Editing: x, d + motion, dd, D, i, I, a, A, o, O, J
 * - Undo/redo: u / U
 * - Clipboard: y/Y copy, p paste (works in visual mode too)
 */

import { execSync, spawn, type IOType } from "node:child_process";
import { CustomEditor, type ExtensionAPI, type Theme } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	lineStart: "\x01", // Ctrl+A
	lineEnd: "\x05", // Ctrl+E
	deleteCharForward: "\x1b[3~",
	deleteWordForward: "\x1bd", // Alt+D
	deleteWordBackward: "\x17", // Ctrl+W
	deleteToEnd: "\x0b", // Ctrl+K
	wordForward: "\x1bf", // Alt+F
	wordBackward: "\x1bb", // Alt+B
	newLine: "\n",
} as const;

type Mode = "normal" | "insert" | "visual" | "visual_line";
type PendingOperator = "d" | "c" | "y" | ">" | "<" | "g~" | "gu" | "gU" | null;
type PendingFind = "f" | "F" | "t" | "T" | null;
type FindType = Exclude<PendingFind, null>;
type RegisterType = "charwise" | "linewise";

interface Pos {
	line: number;
	col: number;
}

interface LastFindCommand {
	type: FindType;
	targetChar: string;
}

interface Snapshot {
	text: string;
	cursor: Pos;
	normalCursor: Pos;
}

interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

interface LayoutSegment {
	logicalLine: number;
	text: string;
	startCol: number;
	endCol: number;
	hasCursor: boolean;
	cursorPos?: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

let activeTheme: Theme | undefined;

function isWhitespaceChar(grapheme: string): boolean {
	return /^\s$/u.test(grapheme);
}

function getSmallWordClass(char: string): 0 | 1 | 2 {
	if (isWhitespaceChar(char)) {
		return 0;
	}
	if (/[A-Za-z0-9_]/.test(char)) {
		return 1;
	}
	return 2;
}

function wordWrapLine(line: string, maxWidth: number): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	if (visibleWidth(line) <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = [...segmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = isWhitespaceChar(grapheme);

		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0) {
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		currentWidth += gWidth;

		const next = segments[i + 1];
		if (isWs && next && !isWhitespaceChar(next.segment)) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		}
	}

	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
	return chunks;
}

class ModalEditor extends CustomEditor {
	private mode: Mode = "insert";
	private pendingCount = "";
	private pendingOperator: PendingOperator = null;
	private pendingOperatorCount = 1;
	private pendingFind: PendingFind = null;
	private pendingG = false;
	private pendingReplace = false;
	private pendingTextObjectPrefix: "i" | "a" | null = null;
	private lastFindCommand: LastFindCommand | null = null;
	private visualAnchor: Pos | null = null;
	private visualScrollOffset = 0;
	private clipboardFallback = "";
	private clipboardFallbackType: RegisterType = "charwise";
	private suppressClipboardWrite = false;
	private undoHistory: Snapshot[] = [];
	private redoHistory: Snapshot[] = [];
	private trackingDepth = 0;
	private trackingStartSnapshot: Snapshot | null = null;
	private insertSessionStart: Pos | null = null;
	private insertFallbackNormalCursor: Pos | null = null;
	private insertSessionEdited = false;
	private modalPreferredCol: number | null = null;

	override setText(text: string): void {
		super.setText(text);
		if (this.mode === "insert") {
			this.primeInsertSession(this.getNormalCursorFromInsertPos(this.getCursor()));
		} else {
			this.clearInsertSession();
		}
	}

	private clonePos(pos: Pos): Pos {
		return { line: pos.line, col: pos.col };
	}

	private samePos(a: Pos | null, b: Pos | null): boolean {
		return a !== null && b !== null && a.line === b.line && a.col === b.col;
	}

	private clearInsertSession(): void {
		this.insertSessionStart = null;
		this.insertFallbackNormalCursor = null;
		this.insertSessionEdited = false;
	}

	private clearModalPreferredCol(): void {
		this.modalPreferredCol = null;
	}

	private getModalLineMaxCol(lineText: string): number {
		if (this.mode === "insert") {
			return lineText.length;
		}
		return lineText.length === 0 ? 0 : lineText.length - 1;
	}

	private clampModalPos(pos: Pos): Pos {
		const lines = this.getLines();
		const maxLine = Math.max(0, lines.length - 1);
		const line = Math.max(0, Math.min(pos.line, maxLine));
		const lineText = lines[line] ?? "";
		const maxCol = this.getModalLineMaxCol(lineText);
		return { line, col: Math.max(0, Math.min(pos.col, maxCol)) };
	}

	private getModalCursor(): Pos {
		return this.clampModalPos(this.getCursor());
	}

	private moveToModalLineStart(): void {
		const cursor = this.getModalCursor();
		this.moveCursorTo({ line: cursor.line, col: 0 });
		this.resetPending();
	}

	private moveHorizontally(count: number, direction: -1 | 1): void {
		const repeats = Math.max(1, count);
		const cursor = this.getModalCursor();
		const lineText = this.getLines()[cursor.line] ?? "";
		const maxCol = this.getModalLineMaxCol(lineText);
		const targetCol = direction < 0 ? Math.max(0, cursor.col - repeats) : Math.min(maxCol, cursor.col + repeats);
		this.moveCursorTo({ line: cursor.line, col: targetCol });
		this.resetPending();
	}

	private moveVertically(count: number, direction: -1 | 1): void {
		const repeats = Math.max(1, count);
		const lines = this.getLines();
		const cursor = this.getModalCursor();
		const maxLine = Math.max(0, lines.length - 1);
		const targetLine = Math.max(0, Math.min(cursor.line + direction * repeats, maxLine));
		const desiredCol = this.modalPreferredCol ?? cursor.col;
		const targetMaxCol = this.getModalLineMaxCol(lines[targetLine] ?? "");
		const targetCol = Math.min(desiredCol, targetMaxCol);
		if (targetCol < desiredCol) {
			this.modalPreferredCol = desiredCol;
		} else {
			this.modalPreferredCol = null;
		}
		this.moveCursorTo({ line: targetLine, col: targetCol }, { preservePreferredCol: true });
		this.resetPending();
	}

	private primeInsertSession(fallbackNormalCursor: Pos): void {
		this.insertSessionStart = this.clonePos(this.getCursor());
		this.insertFallbackNormalCursor = this.clonePos(fallbackNormalCursor);
		this.insertSessionEdited = false;
	}

	private ensureInsertSession(): void {
		if (this.mode !== "insert" || this.insertSessionStart) {
			return;
		}
		this.primeInsertSession(this.getNormalCursorFromInsertPos(this.getCursor()));
	}

	private getNormalCursorFromInsertPos(pos: Pos): Pos {
		const lines = this.getLines();
		const maxLine = Math.max(0, lines.length - 1);
		const line = Math.max(0, Math.min(pos.line, maxLine));
		const lineText = lines[line] ?? "";
		if (lineText.length === 0) {
			return { line, col: 0 };
		}
		return { line, col: Math.max(0, Math.min(pos.col, lineText.length - 1)) };
	}

	private getNormalCursorAfterInsertEdit(pos: Pos): Pos {
		const lines = this.getLines();
		const maxLine = Math.max(0, lines.length - 1);
		const line = Math.max(0, Math.min(pos.line, maxLine));
		const lineText = lines[line] ?? "";
		if (lineText.length === 0) {
			return { line, col: 0 };
		}
		return { line, col: Math.max(0, Math.min(pos.col - 1, lineText.length - 1)) };
	}

	private getCurrentNormalCursor(): Pos {
		const current = this.getCursor();
		if (this.mode !== "insert") {
			return this.getNormalCursorFromInsertPos(current);
		}
		if (this.insertSessionEdited) {
			return this.getNormalCursorAfterInsertEdit(current);
		}
		if (this.insertSessionStart && !this.samePos(current, this.insertSessionStart)) {
			return this.getNormalCursorFromInsertPos(current);
		}
		if (this.insertFallbackNormalCursor) {
			return this.clonePos(this.insertFallbackNormalCursor);
		}
		return this.getNormalCursorFromInsertPos(current);
	}

	private enterInsertModeAtCurrentCursor(fallbackNormalCursor: Pos = this.getNormalCursorFromInsertPos(this.getCursor())): void {
		this.mode = "insert";
		this.primeInsertSession(fallbackNormalCursor);
		this.resetPending();
	}

	private exitInsertMode(): void {
		const target = this.getCurrentNormalCursor();
		this.mode = "normal";
		this.clearInsertSession();
		this.resetPending();
		this.moveCursorTo(target);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.exitInsertMode();
				return;
			}

			if (this.mode === "visual" || this.mode === "visual_line") {
				this.mode = "normal";
				this.visualAnchor = null;
				this.resetPending();
				return;
			}

			if (this.hasPendingCommand()) {
				this.resetPending();
				return;
			}

			super.handleInput(data);
			return;
		}

		if (this.mode === "insert") {
			this.ensureInsertSession();
			const beforeText = this.getText();
			this.withTrackedEdit(() => {
				super.handleInput(data);
			});
			if (this.getText() !== beforeText) {
				this.insertSessionEdited = true;
			}
			return;
		}

		if (this.pendingReplace) {
			const targetChar = this.getPrintableInputChar(data);
			if (targetChar !== null) {
				this.replaceCharsAtCursor(targetChar, this.consumeCount());
			} else {
				this.resetPending();
			}
			return;
		}

		if (this.pendingFind) {
			if (this.pendingOperator && this.pendingOperator !== "d") {
				this.handlePendingOperatorInput(data);
				return;
			}
			const targetChar = this.getPrintableInputChar(data);
			if (targetChar !== null) {
				this.applyFind(targetChar);
			} else {
				this.resetPending();
			}
			return;
		}

		if (this.pendingOperator && data === "0" && this.pendingCount.length === 0) {
			this.handlePendingOperatorInput(data);
			return;
		}

		if (data.length === 1 && data >= "0" && data <= "9") {
			if (data === "0" && this.pendingCount.length === 0 && !this.pendingOperator && !this.pendingG) {
				this.moveToModalLineStart();
				return;
			}
			this.pendingCount += data;
			return;
		}

		if (this.pendingOperator) {
			this.handlePendingOperatorInput(data);
			return;
		}

		if (this.mode === "visual" || this.mode === "visual_line") {
			this.handleVisualInput(data);
			return;
		}

		this.handleNormalInput(data);
	}

	private isOpenBraceInput(data: string): boolean {
		if (data === "{" || matchesKey(data, "{")) {
			return true;
		}
		return parseKey(data) === "shift+[";
	}

	private isCloseBraceInput(data: string): boolean {
		if (data === "}" || matchesKey(data, "}")) {
			return true;
		}
		return parseKey(data) === "shift+]";
	}

	private handleNormalInput(data: string): void {
		const printable = this.getPrintableInputChar(data);
		if (matchesKey(data, "u")) {
			this.undo();
			return;
		}
		if ((matchesKey(data, "shift+u") || printable === "U") && !this.pendingG) {
			this.redo();
			return;
		}
		if (matchesKey(data, "shift+y") || printable === "Y") {
			this.copyCurrentLine();
			this.resetPending();
			return;
		}
		if (matchesKey(data, "p")) {
			this.pasteAtCursor();
			return;
		}
		if ((matchesKey(data, "shift+e") || printable === "E") && !this.pendingG) {
			this.moveWordEndForward(this.consumeCount(), true);
			return;
		}
		if (this.isOpenBraceInput(data)) {
			this.moveParagraphBackward(this.consumeCount());
			return;
		}
		if (this.isCloseBraceInput(data)) {
			this.moveParagraphForward(this.consumeCount());
			return;
		}
		if (this.tryStartFindFromInput(data)) {
			return;
		}

		const command = this.normalizeCommandInput(data);
		if (this.pendingG) {
			this.handlePendingGMotion(command);
			return;
		}

		switch (command) {
			case "h":
				this.moveHorizontally(this.consumeCount(), -1);
				return;
			case "j":
				this.moveVertically(this.consumeCount(), 1);
				return;
			case "k":
				this.moveVertically(this.consumeCount(), -1);
				return;
			case "l":
				this.moveHorizontally(this.consumeCount(), 1);
				return;
			case "G":
				this.moveToAbsoluteLine("last");
				return;
			case "$":
				this.moveToLastCharOnLine();
				return;
			case "w":
				this.moveSmallWordForward(this.consumeCount());
				return;
			case "W":
				this.moveBigWordForward(this.consumeCount());
				return;
			case "b":
				this.moveSmallWordBackward(this.consumeCount());
				return;
			case "B":
				this.moveBigWordBackward(this.consumeCount());
				return;
			case "e":
				this.moveWordEndForward(this.consumeCount(), false);
				return;
			case "%":
				this.moveToMatchingPair();
				return;
			case "(":
				this.moveSentenceBackward(this.consumeCount());
				return;
			case ")":
				this.moveSentenceForward(this.consumeCount());
				return;
			case "{":
				this.moveParagraphBackward(this.consumeCount());
				return;
			case "}":
				this.moveParagraphForward(this.consumeCount());
				return;
			case ";":
				this.repeatLastFind(false);
				return;
			case ",":
				this.repeatLastFind(true);
				return;
			case "g":
				this.pendingG = true;
				return;
			case "x":
				this.captureDeleteToClipboard("charwise", () => {
					this.withTrackedEdit(() => {
						this.send(SEQ.deleteCharForward, this.consumeCount());
					});
				});
				return;
			case "r":
				this.pendingReplace = true;
				return;
			case "^":
				this.moveToFirstNonBlank();
				return;
			case "~":
				this.toggleCaseAtCursor(this.consumeCount());
				return;
			case "s":
				this.substituteChars(this.consumeCount());
				return;
			case "d":
				this.pendingOperator = "d";
				this.pendingOperatorCount = this.consumeCount();
				return;
			case "c":
				this.pendingOperator = "c";
				this.pendingOperatorCount = this.consumeCount();
				return;
			case "y":
				this.pendingOperator = "y";
				this.pendingOperatorCount = this.consumeCount();
				return;
			case ">":
				this.pendingOperator = ">";
				this.pendingOperatorCount = this.consumeCount();
				return;
			case "<":
				this.pendingOperator = "<";
				this.pendingOperatorCount = this.consumeCount();
				return;
			case "D":
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToLineEnd(this.consumeCount());
				});
				return;
			case "C":
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToLineEnd(this.consumeCount());
				});
				this.enterInsertModeAtCurrentCursor();
				return;
			case "S":
				this.substituteLines(this.consumeCount());
				return;
			case "v":
				this.mode = "visual";
				this.visualAnchor = this.getCursor();
				this.resetPending();
				return;
			case "V":
				this.mode = "visual_line";
				this.visualAnchor = this.getCursor();
				this.resetPending();
				return;
			case "i":
				this.enterInsertModeAtCurrentCursor(this.clonePos(this.getCursor()));
				return;
			case "I":
				this.enterInsertAtFirstNonBlank();
				return;
			case "a": {
				const fallback = this.clonePos(this.getCursor());
				this.send(SEQ.right);
				this.enterInsertModeAtCurrentCursor(fallback);
				return;
			}
			case "A":
				this.enterInsertAtLineEnd();
				return;
			case "o":
				this.openLineBelow(this.consumeCount());
				return;
			case "O":
				this.openLineAbove(this.consumeCount());
				return;
			case "J":
				this.joinWithNextLine(this.consumeCount());
				return;
			default:
				if (this.getPrintableInputChar(data) !== null) {
					this.resetPending();
					return;
				}
				this.resetPending();
				super.handleInput(data);
				return;
		}
	}

	private handleVisualInput(data: string): void {
		const printable = this.getPrintableInputChar(data);
		if (matchesKey(data, "u")) {
			this.undo();
			return;
		}
		if (matchesKey(data, "shift+u") || printable === "U") {
			this.redo();
			return;
		}
		if (matchesKey(data, "y")) {
			this.copyVisualSelection(this.mode === "visual_line");
			return;
		}
		if (matchesKey(data, "shift+y") || printable === "Y") {
			this.copyVisualSelection(true);
			return;
		}
		if (matchesKey(data, "p")) {
			this.pasteOverVisualSelection();
			return;
		}
		if ((matchesKey(data, "shift+e") || printable === "E") && !this.pendingG) {
			this.moveWordEndForward(this.consumeCount(), true);
			return;
		}
		if (this.isOpenBraceInput(data)) {
			this.moveParagraphBackward(this.consumeCount());
			return;
		}
		if (this.isCloseBraceInput(data)) {
			this.moveParagraphForward(this.consumeCount());
			return;
		}
		if (this.tryStartFindFromInput(data)) {
			return;
		}

		const command = this.normalizeCommandInput(data);
		if (this.pendingG) {
			this.handlePendingGMotion(command);
			return;
		}

		switch (command) {
			case "v":
				if (this.mode === "visual_line") {
					this.mode = "visual";
					this.resetPending();
					return;
				}
				this.mode = "normal";
				this.visualAnchor = null;
				this.resetPending();
				return;
			case "V":
				if (this.mode === "visual_line") {
					this.mode = "normal";
					this.visualAnchor = null;
				} else {
					this.mode = "visual_line";
					if (!this.visualAnchor) {
						this.visualAnchor = this.getCursor();
					}
				}
				this.resetPending();
				return;
			case "d":
			case "x":
				this.captureDeleteToClipboard(this.mode === "visual_line" ? "linewise" : "charwise", () => {
					this.deleteVisualSelection();
				});
				return;
			case "c":
				if (this.mode === "visual_line") {
					this.captureDeleteToClipboard("linewise", () => {
						this.changeVisualLineSelection();
					});
				} else {
					this.captureDeleteToClipboard("charwise", () => {
						this.deleteVisualSelection();
					});
				}
				this.enterInsertModeAtCurrentCursor();
				return;
			case "o": {
				const current = this.getCursor();
				if (this.visualAnchor) {
					this.moveCursorTo(this.visualAnchor);
					this.visualAnchor = current;
				}
				this.resetPending();
				return;
			}
			case "h":
				this.moveHorizontally(this.consumeCount(), -1);
				return;
			case "j":
				this.moveVertically(this.consumeCount(), 1);
				return;
			case "k":
				this.moveVertically(this.consumeCount(), -1);
				return;
			case "l":
				this.moveHorizontally(this.consumeCount(), 1);
				return;
			case "G":
				this.moveToAbsoluteLine("last");
				return;
			case "$":
				this.moveToLastCharOnLine();
				return;
			case "w":
				this.moveSmallWordForward(this.consumeCount());
				return;
			case "W":
				this.moveBigWordForward(this.consumeCount());
				return;
			case "b":
				this.moveSmallWordBackward(this.consumeCount());
				return;
			case "B":
				this.moveBigWordBackward(this.consumeCount());
				return;
			case "e":
				this.moveWordEndForward(this.consumeCount(), false);
				return;
			case "%":
				this.moveToMatchingPair();
				return;
			case "(":
				this.moveSentenceBackward(this.consumeCount());
				return;
			case ")":
				this.moveSentenceForward(this.consumeCount());
				return;
			case "{":
				this.moveParagraphBackward(this.consumeCount());
				return;
			case "}":
				this.moveParagraphForward(this.consumeCount());
				return;
			case ";":
				this.repeatLastFind(false);
				return;
			case ",":
				this.repeatLastFind(true);
				return;
			case "g":
				this.pendingG = true;
				return;
			default:
				if (this.getPrintableInputChar(data) !== null) {
					this.resetPending();
					return;
				}
				this.resetPending();
				super.handleInput(data);
				return;
		}
	}

	private handlePendingOperatorInput(data: string): void {
		const command = this.normalizeCommandInput(data);
		if (this.pendingTextObjectPrefix) {
			this.handleTextObjectOperand(command);
			return;
		}

		if (command === "i" || command === "a") {
			this.pendingTextObjectPrefix = command;
			return;
		}

		switch (this.pendingOperator) {
			case "d":
				this.handleDeleteOperator(data);
				return;
			case "c":
				this.handleChangeOperator(data);
				return;
			case "y":
				this.handleYankOperator(data);
				return;
			case ">":
				this.handleIndentOperator(data, true);
				return;
			case "<":
				this.handleIndentOperator(data, false);
				return;
			case "g~":
				this.handleCaseOperator(data, "toggle");
				return;
			case "gu":
				this.handleCaseOperator(data, "lower");
				return;
			case "gU":
				this.handleCaseOperator(data, "upper");
				return;
			default:
				this.resetPending();
				return;
		}
	}

	private handleTextObjectOperand(objectCommand: string): void {
		const prefix = this.pendingTextObjectPrefix;
		if (!prefix) {
			this.resetPending();
			return;
		}

		const motionCount = this.consumeCount();
		const total = Math.max(1, this.pendingOperatorCount * motionCount);
		const range = this.resolveTextObjectRange(prefix, objectCommand, total);
		if (!range) {
			this.resetPending();
			return;
		}
		this.applyOperatorToRange(range.startIndex, range.endIndexExclusive, range.linewise);
	}

	private resolveTextObjectRange(
		prefix: "i" | "a",
		objectCommand: string,
		count: number,
	): { startIndex: number; endIndexExclusive: number; linewise: boolean } | null {
		const includeOuter = prefix === "a";
		switch (objectCommand) {
			case "w":
				return this.findWordTextObjectRange(false, includeOuter, count);
			case "W":
				return this.findWordTextObjectRange(true, includeOuter, count);
			case '"':
			case "'":
			case "`":
				return this.findQuoteTextObjectRange(objectCommand, includeOuter, count);
			case "(":
			case ")":
			case "b":
				return this.findDelimitedTextObjectRange("(", ")", includeOuter, count);
			case "[":
			case "]":
				return this.findDelimitedTextObjectRange("[", "]", includeOuter, count);
			case "{":
			case "}":
			case "B":
				return this.findDelimitedTextObjectRange("{", "}", includeOuter, count);
			default:
				return null;
		}
	}

	private findWordTextObjectRange(
		bigWord: boolean,
		includeOuter: boolean,
		count: number,
	): { startIndex: number; endIndexExclusive: number; linewise: boolean } | null {
		const text = this.getText();
		if (!text) {
			return null;
		}

		const cursorIndex = this.posToIndex(this.getLines(), this.getCursor());
		const classify = (char: string): number => (bigWord ? (isWhitespaceChar(char) ? 0 : 1) : getSmallWordClass(char));
		const findUnitNear = (fromIndex: number): { start: number; endExclusive: number } | null => {
			if (!text) {
				return null;
			}
			let probe = Math.max(0, Math.min(fromIndex, text.length - 1));
			if (classify(text[probe] ?? "") === 0) {
				let right = probe;
				while (right < text.length && classify(text[right] ?? "") === 0) {
					right += 1;
				}
				if (right < text.length) {
					probe = right;
				} else {
					let left = probe - 1;
					while (left >= 0 && classify(text[left] ?? "") === 0) {
						left -= 1;
					}
					if (left < 0) {
						return null;
					}
					probe = left;
				}
			}

			const cls = classify(text[probe] ?? "");
			let start = probe;
			while (start > 0 && classify(text[start - 1] ?? "") === cls) {
				start -= 1;
			}
			let end = probe + 1;
			while (end < text.length && classify(text[end] ?? "") === cls) {
				end += 1;
			}
			return { start, endExclusive: end };
		};

		const first = findUnitNear(cursorIndex);
		if (!first) {
			return null;
		}

		let start = first.start;
		let endExclusive = first.endExclusive;
		const repeats = Math.max(1, count);
		for (let step = 1; step < repeats; step++) {
			let probe = endExclusive;
			while (probe < text.length && isWhitespaceChar(text[probe] ?? "")) {
				probe += 1;
			}
			if (probe >= text.length) {
				break;
			}
			const next = findUnitNear(probe);
			if (!next) {
				break;
			}
			endExclusive = next.endExclusive;
		}

		if (includeOuter) {
			let trailing = endExclusive;
			while (trailing < text.length && isWhitespaceChar(text[trailing] ?? "")) {
				trailing += 1;
			}
			if (trailing > endExclusive) {
				endExclusive = trailing;
			} else {
				while (start > 0 && isWhitespaceChar(text[start - 1] ?? "")) {
					start -= 1;
				}
			}
		}

		return { startIndex: start, endIndexExclusive: endExclusive, linewise: false };
	}

	private findQuoteTextObjectRange(
		quoteChar: string,
		includeOuter: boolean,
		count: number,
	): { startIndex: number; endIndexExclusive: number; linewise: boolean } | null {
		const lines = this.getLines();
		const cursor = this.getCursor();
		const lineText = lines[cursor.line] ?? "";
		if (!lineText) {
			return null;
		}

		const isEscaped = (text: string, index: number): boolean => {
			let slashes = 0;
			for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
				slashes += 1;
			}
			return slashes % 2 === 1;
		};

		const quotePositions: number[] = [];
		for (let i = 0; i < lineText.length; i++) {
			if (lineText[i] === quoteChar && !isEscaped(lineText, i)) {
				quotePositions.push(i);
			}
		}
		if (quotePositions.length < 2) {
			return null;
		}

		const pairs: Array<{ start: number; end: number }> = [];
		for (let i = 0; i + 1 < quotePositions.length; i += 2) {
			pairs.push({ start: quotePositions[i]!, end: quotePositions[i + 1]! });
		}

		const relCol = Math.max(0, Math.min(cursor.col, lineText.length));
		let current =
			pairs
				.filter((pair) => pair.start <= relCol && relCol <= pair.end)
				.sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? null;
		if (!current) {
			const nearby = pairs.find((pair) => pair.start >= relCol) ?? pairs[pairs.length - 1] ?? null;
			current = nearby;
		}
		if (!current) {
			return null;
		}

		const repeats = Math.max(1, count);
		for (let step = 1; step < repeats; step++) {
			const outer =
				pairs
					.filter((pair) => pair.start < current!.start && pair.end > current!.end)
					.sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? null;
			if (!outer) {
				break;
			}
			current = outer;
		}

		const lineStartIndex = this.posToIndex(lines, { line: cursor.line, col: 0 });
		const start = lineStartIndex + (includeOuter ? current.start : current.start + 1);
		const end = lineStartIndex + (includeOuter ? current.end + 1 : current.end);
		if (start >= end) {
			return null;
		}
		return { startIndex: start, endIndexExclusive: end, linewise: false };
	}

	private findDelimitedTextObjectRange(
		open: string,
		close: string,
		includeOuter: boolean,
		count: number,
	): { startIndex: number; endIndexExclusive: number; linewise: boolean } | null {
		const text = this.getText();
		if (!text) {
			return null;
		}
		const cursorIndex = this.posToIndex(this.getLines(), this.getCursor());
		const stack: number[] = [];
		const pairs: Array<{ start: number; end: number }> = [];
		for (let i = 0; i < text.length; i++) {
			const ch = text[i] ?? "";
			if (ch === open) {
				stack.push(i);
			} else if (ch === close) {
				const start = stack.pop();
				if (start !== undefined) {
					pairs.push({ start, end: i });
				}
			}
		}
		if (pairs.length === 0) {
			return null;
		}

		let current =
			pairs
				.filter((pair) => pair.start <= cursorIndex && cursorIndex <= pair.end)
				.sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? null;
		if (!current) {
			return null;
		}

		const repeats = Math.max(1, count);
		for (let step = 1; step < repeats; step++) {
			const outer =
				pairs
					.filter((pair) => pair.start < current!.start && pair.end > current!.end)
					.sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? null;
			if (!outer) {
				break;
			}
			current = outer;
		}

		const start = includeOuter ? current.start : current.start + 1;
		const end = includeOuter ? current.end + 1 : current.end;
		if (start >= end) {
			return null;
		}
		return { startIndex: start, endIndexExclusive: end, linewise: false };
	}

	private applyOperatorToRange(startIndex: number, endIndexExclusive: number, linewise: boolean): void {
		const operator = this.pendingOperator;
		if (!operator) {
			this.resetPending();
			return;
		}

		const fullText = this.getText();
		const start = Math.max(0, Math.min(startIndex, fullText.length));
		const end = Math.max(start, Math.min(endIndexExclusive, fullText.length));
		if (start >= end) {
			this.resetPending();
			return;
		}
		const segment = fullText.slice(start, end);

		if (operator === "y") {
			this.writeClipboard(segment, linewise ? "linewise" : "charwise");
			this.resetPending();
			return;
		}

		if (operator === ">" || operator === "<") {
			const startPos = this.indexToPos(fullText, start);
			const endPos = this.indexToPos(fullText, Math.max(start, end - 1));
			this.indentLineRange(startPos.line, endPos.line - startPos.line + 1, operator === ">");
			return;
		}

		if (operator === "d" || operator === "c") {
			this.writeClipboard(segment, linewise ? "linewise" : "charwise");
			this.withTrackedEdit(() => {
				const text = this.getText();
				const nextText = text.slice(0, start) + text.slice(end);
				this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, start));
			});
			if (operator === "c") {
				this.enterInsertModeAtCurrentCursor();
				return;
			}
			this.resetPending();
			return;
		}

		if (operator === "g~" || operator === "gu" || operator === "gU") {
			const kind = operator === "g~" ? "toggle" : operator === "gu" ? "lower" : "upper";
			const replacement = this.transformCase(segment, kind);
			this.withTrackedEdit(() => {
				const text = this.getText();
				const nextText = text.slice(0, start) + replacement + text.slice(end);
				this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, start));
			});
			this.resetPending();
			return;
		}

		this.resetPending();
	}

	private mapOperatorCommandToDeleteMotion(data: string, operator: PendingOperator): string {
		const command = this.normalizeCommandInput(data);
		if (operator === "c" && command === "c") return "d";
		// vim special case: cw/cW act like ce/cE when cursor is on a non-blank
		if (operator === "c" && command === "w") {
			const cursor = this.getCursor();
			const line = this.getLines()[cursor.line] ?? "";
			const ch = line[cursor.col] ?? "";
			if (ch && !isWhitespaceChar(ch)) return "e";
		}
		if (operator === "c" && command === "W") {
			const cursor = this.getCursor();
			const line = this.getLines()[cursor.line] ?? "";
			const ch = line[cursor.col] ?? "";
			if (ch && !isWhitespaceChar(ch)) return "E";
		}
		if (operator === "y" && command === "y") return "d";
		if (operator === "g~" && command === "~") return "d";
		if (operator === "gu" && command === "u") return "d";
		if (operator === "gU" && command === "U") return "d";
		return data;
	}

	private getDeletedSegment(beforeText: string, afterText: string): { startIndex: number; deletedText: string } | null {
		if (beforeText === afterText) {
			return null;
		}

		let start = 0;
		const sharedPrefixMax = Math.min(beforeText.length, afterText.length);
		while (start < sharedPrefixMax && beforeText[start] === afterText[start]) {
			start += 1;
		}

		let beforeEnd = beforeText.length - 1;
		let afterEnd = afterText.length - 1;
		while (beforeEnd >= start && afterEnd >= start && beforeText[beforeEnd] === afterText[afterEnd]) {
			beforeEnd -= 1;
			afterEnd -= 1;
		}

		const deletedText = beforeText.slice(start, beforeEnd + 1);
		if (!deletedText) {
			return null;
		}
		return { startIndex: start, deletedText };
	}

	private normalizeLinewiseRegisterText(text: string): string {
		let normalized = text;
		if (normalized.startsWith("\n")) {
			normalized = normalized.slice(1);
		}
		if (normalized.endsWith("\n")) {
			normalized = normalized.slice(0, -1);
		}
		return normalized;
	}

	private captureDeleteToClipboard(type: RegisterType, action: () => void): void {
		const beforeText = this.getText();
		action();
		if (this.suppressClipboardWrite) {
			return;
		}

		const deleted = this.getDeletedSegment(beforeText, this.getText());
		if (!deleted) {
			return;
		}

		const text = type === "linewise" ? this.normalizeLinewiseRegisterText(deleted.deletedText) : deleted.deletedText;
		this.writeClipboard(text, type);
	}

	private runDeleteProxy(data: string, operator: Exclude<PendingOperator, null | "d">): {
		status: "pending" | "applied" | "noop";
		before: Snapshot;
		after: Snapshot;
		deleted: { startIndex: number; deletedText: string } | null;
		linewise: boolean;
		undoBackup: Snapshot[];
		redoBackup: Snapshot[];
	} {
		const before = this.captureSnapshot();
		const undoBackup = [...this.undoHistory];
		const redoBackup = [...this.redoHistory];
		const forwardedData = this.mapOperatorCommandToDeleteMotion(data, operator);
		const hadPendingG = this.pendingG;

		const previousSuppressClipboardWrite = this.suppressClipboardWrite;
		this.suppressClipboardWrite = true;
		this.pendingOperator = "d";
		try {
			this.handleDeleteOperator(forwardedData);
		} finally {
			this.suppressClipboardWrite = previousSuppressClipboardWrite;
		}
		const after = this.captureSnapshot();

		if (this.pendingFind || this.pendingG) {
			this.pendingOperator = operator;
			this.undoHistory = undoBackup;
			this.redoHistory = redoBackup;
			this.restoreSnapshot(before);
			return { status: "pending", before, after, deleted: null, linewise: false, undoBackup, redoBackup };
		}

		const deleted = this.getDeletedSegment(before.text, after.text);
		if (!deleted) {
			return { status: "noop", before, after, deleted: null, linewise: false, undoBackup, redoBackup };
		}

		const normalized = this.normalizeCommandInput(forwardedData);
		const linewise = normalized === "d" || normalized === "j" || normalized === "k" || normalized === "G" || (hadPendingG && normalized === "g");
		return { status: "applied", before, after, deleted, linewise, undoBackup, redoBackup };
	}

	private handleChangeOperator(data: string): void {
		// vim special case: cc clears line content but keeps the line
		const command = this.normalizeCommandInput(data);
		if (command === "c") {
			const motionCount = this.consumeCount();
			const total = Math.max(1, this.pendingOperatorCount * motionCount);
			const cursor = this.getCursor();
			const lines = this.getLines();
			const startLine = cursor.line;
			const endLine = Math.min(lines.length - 1, startLine + total - 1);
			const deletedLines = lines.slice(startLine, endLine + 1).join("\n");
			this.writeClipboard(deletedLines, "linewise");
			this.withTrackedEdit(() => {
				const nextLines = this.getLines();
				nextLines.splice(startLine, endLine - startLine + 1, "");
				if (nextLines.length === 0) nextLines.push("");
				this.setTextAndMoveCursor(nextLines.join("\n"), { line: startLine, col: 0 });
			});
			this.enterInsertModeAtCurrentCursor();
			return;
		}

		const result = this.runDeleteProxy(data, "c");
		if (result.status === "pending") {
			return;
		}
		if (result.status === "applied" && result.deleted) {
			const text = result.linewise ? this.normalizeLinewiseRegisterText(result.deleted.deletedText) : result.deleted.deletedText;
			this.writeClipboard(text, result.linewise ? "linewise" : "charwise");
			this.enterInsertModeAtCurrentCursor();
		}
	}

	private handleYankOperator(data: string): void {
		const result = this.runDeleteProxy(data, "y");
		if (result.status === "pending") {
			return;
		}

		this.undoHistory = result.undoBackup;
		this.redoHistory = result.redoBackup;
		this.restoreSnapshot(result.before);

		if (result.status === "applied" && result.deleted) {
			const text = result.linewise ? this.normalizeLinewiseRegisterText(result.deleted.deletedText) : result.deleted.deletedText;
			this.writeClipboard(text, result.linewise ? "linewise" : "charwise");
		}
		this.resetPending();
	}

	private transformCase(text: string, kind: "toggle" | "lower" | "upper"): string {
		if (kind === "lower") {
			return text.toLowerCase();
		}
		if (kind === "upper") {
			return text.toUpperCase();
		}
		let out = "";
		for (const ch of text) {
			const lower = ch.toLowerCase();
			const upper = ch.toUpperCase();
			if (ch === lower && ch !== upper) out += upper;
			else if (ch === upper && ch !== lower) out += lower;
			else out += ch;
		}
		return out;
	}

	private handleCaseOperator(data: string, kind: "toggle" | "lower" | "upper"): void {
		const operator = this.pendingOperator;
		if (!operator || operator === "d") {
			this.resetPending();
			return;
		}
		const result = this.runDeleteProxy(data, operator as Exclude<PendingOperator, null | "d">);
		if (result.status === "pending") {
			return;
		}

		this.undoHistory = result.undoBackup;
		this.redoHistory = result.redoBackup;
		this.restoreSnapshot(result.before);

		if (result.status === "applied" && result.deleted) {
			const replacement = this.transformCase(result.deleted.deletedText, kind);
			this.withTrackedEdit(() => {
				const text = this.getText();
				const start = result.deleted!.startIndex;
				const end = start + result.deleted!.deletedText.length;
				const nextText = text.slice(0, start) + replacement + text.slice(end);
				this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, start));
			});
		}
		this.resetPending();
	}

	private handleIndentOperator(data: string, indent: boolean): void {
		const op = indent ? ">" : "<";
		const command = this.normalizeCommandInput(data);
		const motionCount = this.consumeCount();
		const total = Math.max(1, this.pendingOperatorCount * motionCount);
		const cursor = this.getCursor();

		if (command === op) {
			this.indentLineRange(cursor.line, total, indent);
			return;
		}
		if (command === "j") {
			this.indentLineRange(cursor.line, total + 1, indent);
			return;
		}
		if (command === "k") {
			const startLine = Math.max(0, cursor.line - total);
			const lines = cursor.line - startLine + 1;
			this.indentLineRange(startLine, lines, indent);
			return;
		}
		this.resetPending();
	}

	private indentLineRange(startLine: number, count: number, indent: boolean): void {
		const width = 2;
		this.withTrackedEdit(() => {
			const lines = this.getLines();
			const start = Math.max(0, Math.min(startLine, Math.max(0, lines.length - 1)));
			const endExclusive = Math.min(lines.length, start + Math.max(1, count));
			for (let i = start; i < endExclusive; i++) {
				const line = lines[i] ?? "";
				if (indent) {
					lines[i] = `${" ".repeat(width)}${line}`;
				} else if (line.startsWith("\t")) {
					lines[i] = line.slice(1);
				} else {
					const spacePrefix = line.match(/^ +/)?.[0].length ?? 0;
					lines[i] = line.slice(Math.min(width, spacePrefix));
				}
			}
			this.setTextAndMoveCursor(lines.join("\n"), this.getCursor());
		});
		this.resetPending();
	}

	private handleDeleteOperator(data: string): void {
		const printable = this.getPrintableInputChar(data);
		if ((matchesKey(data, "shift+w") || printable === "W") && !this.pendingG) {
			const motionCount = this.consumeCount();
			const total = Math.max(1, this.pendingOperatorCount * motionCount);
			this.captureDeleteToClipboard("charwise", () => {
				this.deleteToWordStartForward(total, true);
			});
			return;
		}
		if ((matchesKey(data, "shift+e") || printable === "E") && !this.pendingG) {
			const motionCount = this.consumeCount();
			const total = Math.max(1, this.pendingOperatorCount * motionCount);
			this.captureDeleteToClipboard("charwise", () => {
				this.deleteToWordEndForward(total, true);
			});
			return;
		}
		if (this.tryStartFindFromInput(data)) {
			return;
		}

		const command = this.normalizeCommandInput(data);
		if (this.pendingG) {
			this.handlePendingGDeleteMotion(command);
			return;
		}

		switch (command) {
			case "d": {
				const motionCount = this.consumeCount();
				const totalLines = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("linewise", () => {
					this.deleteCurrentLine(totalLines);
				});
				return;
			}
			case "w": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToWordStartForward(total, false);
				});
				return;
			}
			case "W": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToWordStartForward(total, true);
				});
				return;
			}
			case "e": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToWordEndForward(total, false);
				});
				return;
			}
			case "b": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToSmallWordStartBackward(total);
				});
				return;
			}
			case "B": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteBigWordBackward(total);
				});
				return;
			}
			case ";":
				this.repeatLastFind(false);
				return;
			case ",":
				this.repeatLastFind(true);
				return;
			case "g":
				this.pendingG = true;
				return;
			case "%":
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToMatchingPair();
				});
				return;
			case "l": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.withTrackedEdit(() => {
						this.send(SEQ.deleteCharForward, total);
					});
					this.resetPending();
				});
				return;
			}
			case "G":
				this.captureDeleteToClipboard("linewise", () => {
					this.deleteLinesThroughAbsoluteLine("last");
				});
				return;
			case "h": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteCharsBackward(total);
				});
				return;
			}
			case "$": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToLineEnd(total);
				});
				return;
			}
			case "0": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToLineStart(total);
				});
				return;
			}
			case "j": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("linewise", () => {
					this.deleteLinesDown(total);
				});
				return;
			}
			case "k": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("linewise", () => {
					this.deleteLinesUp(total);
				});
				return;
			}
			default:
				this.resetPending();
				return;
		}
	}

	private handlePendingGMotion(command: string): void {
		switch (command) {
			case "g":
				this.moveToAbsoluteLine("first");
				return;
			case "e":
				this.moveWordEndBackward(this.consumeCount(), false);
				return;
			case "E":
				this.moveWordEndBackward(this.consumeCount(), true);
				return;
			case "~":
				this.pendingOperator = "g~";
				this.pendingOperatorCount = this.consumeCount();
				this.pendingG = false;
				return;
			case "u":
				this.pendingOperator = "gu";
				this.pendingOperatorCount = this.consumeCount();
				this.pendingG = false;
				return;
			case "U":
				this.pendingOperator = "gU";
				this.pendingOperatorCount = this.consumeCount();
				this.pendingG = false;
				return;
			default:
				this.resetPending();
				return;
		}
	}

	private handlePendingGDeleteMotion(command: string): void {
		switch (command) {
			case "g":
				this.captureDeleteToClipboard("linewise", () => {
					this.deleteLinesThroughAbsoluteLine("first");
				});
				return;
			case "e": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToWordEndBackward(total, false);
				});
				return;
			}
			case "E": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteToWordEndBackward(total, true);
				});
				return;
			}
			default:
				this.resetPending();
				return;
		}
	}

	private normalizeCommandInput(data: string): string {
		if (matchesKey(data, "h")) return "h";
		if (matchesKey(data, "j")) return "j";
		if (matchesKey(data, "k")) return "k";
		if (matchesKey(data, "l")) return "l";
		if (matchesKey(data, "w")) return "w";
		if (matchesKey(data, "b")) return "b";
		if (matchesKey(data, "e")) return "e";
		if (matchesKey(data, "x")) return "x";
		if (matchesKey(data, "d")) return "d";
		if (matchesKey(data, "c")) return "c";
		if (matchesKey(data, "y")) return "y";
		if (matchesKey(data, ">")) return ">";
		if (matchesKey(data, "<")) return "<";
		if (matchesKey(data, "~")) return "~";
		if (matchesKey(data, "v")) return "v";
		if (matchesKey(data, "shift+v")) return "V";
		if (matchesKey(data, "i")) return "i";
		if (matchesKey(data, "a")) return "a";
		if (matchesKey(data, "o")) return "o";
		if (matchesKey(data, "g")) return "g";
		if (matchesKey(data, "$")) return "$";
		if (matchesKey(data, ";")) return ";";
		if (matchesKey(data, ",")) return ",";
		if (matchesKey(data, "%")) return "%";
		if (matchesKey(data, "(")) return "(";
		if (matchesKey(data, ")")) return ")";
		if (matchesKey(data, "{")) return "{";
		if (matchesKey(data, "}")) return "}";
		const parsed = parseKey(data);
		if (parsed === "shift+[") return "{";
		if (parsed === "shift+]") return "}";

		if (matchesKey(data, "shift+b")) return "B";
		if (matchesKey(data, "shift+c")) return "C";
		if (matchesKey(data, "shift+d")) return "D";
		if (matchesKey(data, "shift+i")) return "I";
		if (matchesKey(data, "shift+a")) return "A";
		if (matchesKey(data, "shift+o")) return "O";
		if (matchesKey(data, "shift+j")) return "J";
		if (matchesKey(data, "shift+e")) return "E";
		if (matchesKey(data, "shift+g")) return "G";
		if (matchesKey(data, "shift+s")) return "S";
		if (matchesKey(data, "shift+w")) return "W";
		if (matchesKey(data, "shift+6")) return "^";
		if (matchesKey(data, "^")) return "^";

		const printable = this.getPrintableInputChar(data);
		if (printable !== null) {
			return printable;
		}

		return data;
	}

	private getPrintableInputChar(data: string): string | null {
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			return data;
		}

		const parsed = parseKey(data);
		if (parsed) {
			if (parsed.length === 1 && parsed.charCodeAt(0) >= 32) {
				return parsed;
			}

			const shiftedLetter = parsed.match(/^shift\+([a-z])$/);
			if (shiftedLetter) {
				return shiftedLetter[1]!.toUpperCase();
			}
		}

		const kittyUnicodeMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?u$/);
		if (!kittyUnicodeMatch) {
			return null;
		}

		const codepoint = Number.parseInt(kittyUnicodeMatch[1]!, 10);
		if (!Number.isFinite(codepoint) || codepoint < 32) {
			return null;
		}

		let ch = String.fromCodePoint(codepoint);
		const modifier = kittyUnicodeMatch[2] ? Number.parseInt(kittyUnicodeMatch[2]!, 10) : 1;
		const hasShift = Number.isFinite(modifier) && ((modifier - 1) & 1) === 1;
		if (hasShift && /^[a-z]$/.test(ch)) {
			ch = ch.toUpperCase();
		}

		return ch;
	}

	private tryStartFindFromInput(data: string): boolean {
		if (matchesKey(data, "f")) {
			this.pendingFind = "f";
			return true;
		}
		if (matchesKey(data, "shift+f")) {
			this.pendingFind = "F";
			return true;
		}
		if (matchesKey(data, "t")) {
			this.pendingFind = "t";
			return true;
		}
		if (matchesKey(data, "shift+t")) {
			this.pendingFind = "T";
			return true;
		}

		const printable = this.getPrintableInputChar(data);
		if (printable === "f") {
			this.pendingFind = "f";
			return true;
		}
		if (printable === "F") {
			this.pendingFind = "F";
			return true;
		}
		if (printable === "t") {
			this.pendingFind = "t";
			return true;
		}
		if (printable === "T") {
			this.pendingFind = "T";
			return true;
		}
		return false;
	}

	private applyFind(targetChar: string, findOverride: FindType | null = null, rememberAsLast: boolean = true): void {
		const findType = findOverride ?? this.pendingFind;
		const operator = this.pendingOperator;
		const occurrenceCount = this.consumeCount();
		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";

		if (!findType) {
			this.resetPending();
			return;
		}

		const isBackward = findType === "F" || findType === "T";
		let foundIndex = -1;
		let from = isBackward ? col - 1 : col + 1;
		const searchRepeats =
			Math.max(1, occurrenceCount) * (operator === "d" ? Math.max(1, this.pendingOperatorCount) : 1);

		if (isBackward && from < 0) {
			this.resetPending();
			return;
		}

		for (let i = 0; i < searchRepeats; i++) {
			foundIndex = isBackward ? currentLine.lastIndexOf(targetChar, from) : currentLine.indexOf(targetChar, from);
			if (foundIndex < 0) {
				this.resetPending();
				return;
			}
			from = isBackward ? foundIndex - 1 : foundIndex + 1;
		}

		if (rememberAsLast) {
			this.lastFindCommand = { type: findType, targetChar };
		}

		if (operator === "d") {
			if (isBackward) {
				const targetStart = findType === "F" ? foundIndex : Math.min(col, foundIndex + 1);
				const deleteEnd = col + (col < currentLine.length ? 1 : 0);
				this.captureDeleteToClipboard("charwise", () => {
					this.deleteRangeInCurrentLine(targetStart, deleteEnd);
				});
				return;
			}

			const totalDeletesForMotion =
				findType === "f" ? Math.max(0, foundIndex - col + 1) : Math.max(0, foundIndex - col);
			this.captureDeleteToClipboard("charwise", () => {
				this.withTrackedEdit(() => {
					this.send(SEQ.deleteCharForward, totalDeletesForMotion);
				});
				this.resetPending();
			});
			return;
		}

		if (isBackward) {
			const targetCol = findType === "F" ? foundIndex : Math.min(col, foundIndex + 1);
			const steps = Math.max(0, col - targetCol);
			this.send(SEQ.left, steps);
			this.resetPending();
			return;
		}

		const targetCol = findType === "f" ? foundIndex : Math.max(col, foundIndex - 1);
		const steps = Math.max(0, targetCol - col);
		this.send(SEQ.right, steps);
		this.resetPending();
	}

	private getOppositeFindType(type: FindType): FindType {
		if (type === "f") return "F";
		if (type === "F") return "f";
		if (type === "t") return "T";
		return "t";
	}

	private repeatLastFind(reverse: boolean): void {
		if (!this.lastFindCommand) {
			this.resetPending();
			return;
		}
		const findType = reverse ? this.getOppositeFindType(this.lastFindCommand.type) : this.lastFindCommand.type;
		this.applyFind(this.lastFindCommand.targetChar, findType, false);
	}

	private moveSmallWordForward(count: number): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const fromIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findSmallWordStartForward(fullText, fromIndex, repeats);
		this.moveCursorTo(this.indexToPos(fullText, targetIndex));
		this.resetPending();
	}

	private moveSmallWordBackward(count: number): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const fromIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findSmallWordStartBackward(fullText, fromIndex, repeats);
		this.moveCursorTo(this.indexToPos(fullText, targetIndex));
		this.resetPending();
	}

	private moveBigWordForward(count: number): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const fromIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findBigWordStartForward(fullText, fromIndex, repeats);
		this.moveCursorTo(this.indexToPos(fullText, targetIndex));
		this.resetPending();
	}

	private moveBigWordBackward(count: number): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const fromIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findBigWordStartBackward(fullText, fromIndex, repeats);
		this.moveCursorTo(this.indexToPos(fullText, targetIndex));
		this.resetPending();
	}

	private moveWordEndBackward(count: number, bigWord: boolean): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const fromIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findWordEndBackward(fullText, fromIndex, repeats, bigWord);
		this.moveCursorTo(this.indexToPos(fullText, targetIndex));
		this.resetPending();
	}

	private deleteToWordStartForward(count: number, bigWord: boolean): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const cursorIndex = this.posToIndex(lines, cursor);
		const targetIndex = bigWord
			? this.findBigWordStartForward(fullText, cursorIndex, repeats)
			: this.findSmallWordStartForward(fullText, cursorIndex, repeats);
		const deleteStart = cursorIndex;
		let deleteEnd = Math.min(fullText.length, targetIndex);

		// vim special case: dw/dW should not cross a newline boundary
		const newlineIndex = fullText.indexOf("\n", cursorIndex);
		if (newlineIndex >= 0 && newlineIndex < deleteEnd) {
			deleteEnd = newlineIndex;
		}

		if (deleteStart >= deleteEnd) {
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const nextText = fullText.slice(0, deleteStart) + fullText.slice(deleteEnd);
			this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, deleteStart));
		});
		this.resetPending();
	}

	private deleteToSmallWordStartBackward(count: number): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const cursorIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findSmallWordStartBackward(fullText, cursorIndex, repeats);
		const deleteStart = targetIndex;
		const deleteEnd = cursorIndex;

		if (deleteStart >= deleteEnd) {
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const nextText = fullText.slice(0, deleteStart) + fullText.slice(deleteEnd);
			this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, deleteStart));
		});
		this.resetPending();
	}

	private deleteToWordEndForward(count: number, bigWord: boolean): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const cursorIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findWordEndForward(fullText, cursorIndex, repeats, bigWord);
		const deleteStart = cursorIndex;
		const deleteEnd = Math.min(fullText.length, targetIndex + 1);

		if (deleteStart >= deleteEnd) {
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const nextText = fullText.slice(0, deleteStart) + fullText.slice(deleteEnd);
			this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, deleteStart));
		});
		this.resetPending();
	}

	private deleteToWordEndBackward(count: number, bigWord: boolean): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const cursorIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findWordEndBackward(fullText, cursorIndex, repeats, bigWord);
		const deleteStart = Math.max(0, targetIndex);
		const deleteEnd = Math.min(fullText.length, cursorIndex + (cursorIndex < fullText.length ? 1 : 0));

		if (deleteStart >= deleteEnd) {
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const nextText = fullText.slice(0, deleteStart) + fullText.slice(deleteEnd);
			this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, deleteStart));
		});
		this.resetPending();
	}

	private moveSentenceForward(count: number): void {
		const repeats = Math.max(1, count);
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const starts = this.getSentenceStarts(fullText);
		let index = this.posToIndex(lines, this.getCursor());

		for (let step = 0; step < repeats; step++) {
			const nextStart = starts.find((start) => start > index);
			if (nextStart === undefined) {
				index = fullText.length;
				break;
			}
			index = nextStart;
		}

		this.moveCursorTo(this.indexToPos(fullText, index));
		this.resetPending();
	}

	private moveSentenceBackward(count: number): void {
		const repeats = Math.max(1, count);
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const starts = this.getSentenceStarts(fullText);
		let index = this.posToIndex(lines, this.getCursor());

		for (let step = 0; step < repeats; step++) {
			let previousStart = 0;
			for (const start of starts) {
				if (start < index) {
					previousStart = start;
				} else {
					break;
				}
			}
			index = previousStart;
		}

		this.moveCursorTo(this.indexToPos(fullText, index));
		this.resetPending();
	}

	private moveParagraphForward(count: number): void {
		const repeats = Math.max(1, count);
		const lines = this.getLines();
		let targetLine = this.getCursor().line;

		for (let step = 0; step < repeats; step++) {
			let probe = targetLine + 1;
			// Skip non-blank lines to find the next blank line
			while (probe < lines.length && !this.isBlankLine(lines[probe] ?? "")) {
				probe += 1;
			}
			if (probe >= lines.length) {
				targetLine = Math.max(0, lines.length - 1);
				break;
			}
			// Land ON the blank line (vim behavior)
			targetLine = probe;
		}

		this.moveCursorTo({ line: targetLine, col: 0 });
		this.resetPending();
	}

	private moveParagraphBackward(count: number): void {
		const repeats = Math.max(1, count);
		const lines = this.getLines();
		let targetLine = this.getCursor().line;

		for (let step = 0; step < repeats; step++) {
			let probe = targetLine - 1;
			// Skip non-blank lines to find the previous blank line
			while (probe >= 0 && !this.isBlankLine(lines[probe] ?? "")) {
				probe -= 1;
			}
			if (probe < 0) {
				targetLine = 0;
				break;
			}
			// Land ON the blank line (vim behavior)
			targetLine = probe;
		}

		this.moveCursorTo({ line: targetLine, col: 0 });
		this.resetPending();
	}

	private getAbsoluteLineTarget(defaultLine: "first" | "last"): number {
		const lines = this.getLines();
		if (this.pendingCount.length === 0) {
			return defaultLine === "first" ? 0 : lines.length - 1;
		}

		const targetLine = this.consumeCount() - 1;
		return Math.max(0, Math.min(targetLine, lines.length - 1));
	}

	private getFirstNonBlankCol(line: string): number {
		const firstNonBlank = line.search(/\S/);
		return firstNonBlank >= 0 ? firstNonBlank : 0;
	}

	private moveToAbsoluteLine(defaultLine: "first" | "last"): void {
		const lines = this.getLines();
		const targetLine = this.getAbsoluteLineTarget(defaultLine);
		const targetCol = this.getFirstNonBlankCol(lines[targetLine] ?? "");
		this.moveCursorTo({ line: targetLine, col: targetCol });
		this.resetPending();
	}

	private replaceCharsAtCursor(char: string, count: number): void {
		const cursor = this.getCursor();
		const lines = this.getLines();
		const currentLine = lines[cursor.line] ?? "";
		if (cursor.col >= currentLine.length) {
			this.resetPending();
			return;
		}

		const replaceCount = Math.max(1, count);
		if (replaceCount > currentLine.length - cursor.col) {
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const nextLines = this.getLines();
			const line = nextLines[cursor.line] ?? "";
			nextLines[cursor.line] = `${line.slice(0, cursor.col)}${char.repeat(replaceCount)}${line.slice(cursor.col + replaceCount)}`;
			this.setTextAndMoveCursor(nextLines.join("\n"), { line: cursor.line, col: cursor.col + replaceCount - 1 });
		});
		this.resetPending();
	}

	private deleteLinesThroughAbsoluteLine(defaultLine: "first" | "last"): void {
		const cursorLine = this.getCursor().line;
		const targetLine = this.getAbsoluteLineTarget(defaultLine);
		const startLine = Math.min(cursorLine, targetLine);
		const deleteCount = Math.abs(cursorLine - targetLine) + 1;
		this.deleteLinesAt(startLine, deleteCount);
	}

	private moveToMatchingPair(count: number = this.consumeCount()): void {
		const repeats = Math.max(1, count);
		for (let step = 0; step < repeats; step++) {
			const lines = this.getLines();
			const fullText = lines.join("\n");
			const cursorIndex = this.posToIndex(lines, this.getCursor());
			const targetIndex = this.findMatchingPairIndex(fullText, cursorIndex);
			if (targetIndex === null) {
				this.resetPending();
				return;
			}
			this.moveCursorTo(this.indexToPos(fullText, targetIndex));
		}
		this.resetPending();
	}

	private deleteToMatchingPair(count?: number): void {
		const repeats = Math.max(1, count ?? Math.max(1, this.pendingOperatorCount * this.consumeCount()));
		this.withTrackedEdit(() => {
			for (let step = 0; step < repeats; step++) {
				const lines = this.getLines();
				const fullText = lines.join("\n");
				const cursor = this.getCursor();
				const cursorIndex = this.posToIndex(lines, cursor);
				const targetIndex = this.findMatchingPairIndex(fullText, cursorIndex);
				if (targetIndex === null) {
					break;
				}
				const start = Math.min(cursorIndex, targetIndex);
				const end = Math.min(fullText.length, Math.max(cursorIndex, targetIndex) + 1);
				if (start >= end) {
					break;
				}
				const nextText = fullText.slice(0, start) + fullText.slice(end);
				this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, start));
			}
		});
		this.resetPending();
	}

	private findBigWordStartForward(text: string, fromIndex: number, repeats: number): number {
		let index = Math.max(0, Math.min(fromIndex, text.length));
		const steps = Math.max(1, repeats);

		for (let step = 0; step < steps; step++) {
			if (index >= text.length) {
				return text.length;
			}

			let probe = index;
			if (!isWhitespaceChar(text[probe] ?? "")) {
				while (probe < text.length && !isWhitespaceChar(text[probe] ?? "")) {
					probe += 1;
				}
			}
			while (probe < text.length && isWhitespaceChar(text[probe] ?? "")) {
				probe += 1;
			}
			index = probe;
		}

		return index;
	}

	private findSmallWordStartForward(text: string, fromIndex: number, repeats: number): number {
		let index = Math.max(0, Math.min(fromIndex, text.length));
		const steps = Math.max(1, repeats);

		for (let step = 0; step < steps; step++) {
			if (index >= text.length) {
				return text.length;
			}

			const ch = text[index] ?? "";
			if (isWhitespaceChar(ch)) {
				while (index < text.length && isWhitespaceChar(text[index] ?? "")) {
					index += 1;
				}
			} else {
				const cls = getSmallWordClass(ch);
				while (index < text.length && getSmallWordClass(text[index] ?? "") === cls) {
					index += 1;
				}
				while (index < text.length && isWhitespaceChar(text[index] ?? "")) {
					index += 1;
				}
			}
		}

		return index;
	}

	private findSmallWordStartBackward(text: string, fromIndex: number, repeats: number): number {
		let index = Math.max(0, Math.min(fromIndex, text.length));
		const steps = Math.max(1, repeats);

		for (let step = 0; step < steps; step++) {
			if (index <= 0) {
				return 0;
			}

			index -= 1;
			while (index >= 0 && isWhitespaceChar(text[index] ?? "")) {
				index -= 1;
			}
			if (index < 0) {
				return 0;
			}

			const cls = getSmallWordClass(text[index] ?? "");
			while (index > 0 && getSmallWordClass(text[index - 1] ?? "") === cls) {
				index -= 1;
			}
		}

		return index;
	}

	private findWordEndForward(text: string, fromIndex: number, repeats: number, bigWord: boolean): number {
		if (text.length === 0) {
			return 0;
		}

		let probe = Math.max(0, Math.min(fromIndex, text.length - 1));
		const steps = Math.max(1, repeats);

		for (let step = 0; step < steps; step++) {
			// Move off current position first (vim e always advances at least one char)
			probe += 1;
			if (probe >= text.length) {
				return text.length - 1;
			}

			// Skip whitespace
			while (probe < text.length && isWhitespaceChar(text[probe] ?? "")) {
				probe += 1;
			}
			if (probe >= text.length) {
				return text.length - 1;
			}

			// Advance to end of current word
			if (bigWord) {
				while (probe + 1 < text.length && !isWhitespaceChar(text[probe + 1] ?? "")) {
					probe += 1;
				}
			} else {
				const cls = getSmallWordClass(text[probe] ?? "");
				while (probe + 1 < text.length && getSmallWordClass(text[probe + 1] ?? "") === cls) {
					probe += 1;
				}
			}
		}

		return Math.min(probe, text.length - 1);
	}

	private findWordEndBackward(text: string, fromIndex: number, repeats: number, bigWord: boolean): number {
		if (text.length === 0) {
			return 0;
		}

		let probe = Math.max(0, Math.min(fromIndex, text.length - 1));
		const steps = Math.max(1, repeats);
		let result = 0;

		for (let step = 0; step < steps; step++) {
			if (!isWhitespaceChar(text[probe] ?? "")) {
				if (bigWord) {
					while (probe >= 0 && !isWhitespaceChar(text[probe] ?? "")) {
						probe -= 1;
					}
				} else {
					const cls = getSmallWordClass(text[probe] ?? "");
					while (probe >= 0 && getSmallWordClass(text[probe] ?? "") === cls) {
						probe -= 1;
					}
				}
			}

			while (probe >= 0 && isWhitespaceChar(text[probe] ?? "")) {
				probe -= 1;
			}
			if (probe < 0) {
				return 0;
			}

			result = probe;
		}

		return result;
	}

	private getSentenceStarts(text: string): number[] {
		const starts = [0];
		const sentenceBoundary = /[.!?][)"'\]]*\s+/g;
		let match: RegExpExecArray | null;
		while ((match = sentenceBoundary.exec(text)) !== null) {
			let start = match.index + match[0].length;
			while (start < text.length && isWhitespaceChar(text[start] ?? "")) {
				start += 1;
			}
			if (start < text.length && starts[starts.length - 1] !== start) {
				starts.push(start);
			}
		}
		return starts;
	}

	private findMatchingPairIndex(text: string, fromIndex: number): number | null {
		if (text.length === 0) {
			return null;
		}

		const openingToClosing: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
		const closingToOpening: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
		let index = Math.max(0, Math.min(fromIndex, text.length - 1));
		let ch = text[index] ?? "";

		// vim %: if not on a bracket, scan forward on current line to find one
		if (!openingToClosing[ch] && !closingToOpening[ch]) {
			const lineEnd = text.indexOf("\n", index);
			const end = lineEnd < 0 ? text.length : lineEnd;
			for (let scan = index + 1; scan < end; scan++) {
				const sc = text[scan] ?? "";
				if (openingToClosing[sc] || closingToOpening[sc]) {
					index = scan;
					ch = sc;
					break;
				}
			}
		}

		if (openingToClosing[ch]) {
			const open = ch;
			const close = openingToClosing[ch]!;
			let depth = 0;
			for (let i = index; i < text.length; i++) {
				const c = text[i] ?? "";
				if (c === open) depth += 1;
				if (c === close) depth -= 1;
				if (depth === 0) return i;
			}
			return null;
		}

		if (closingToOpening[ch]) {
			const close = ch;
			const open = closingToOpening[ch]!;
			let depth = 0;
			for (let i = index; i >= 0; i--) {
				const c = text[i] ?? "";
				if (c === close) depth += 1;
				if (c === open) depth -= 1;
				if (depth === 0) return i;
			}
			return null;
		}

		return null;
	}

	private isBlankLine(line: string): boolean {
		return /^\s*$/.test(line);
	}

	private moveBigWordBackward(count: number): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const fromIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findBigWordStartBackward(fullText, fromIndex, repeats);
		this.moveCursorTo(this.indexToPos(fullText, targetIndex));
		this.resetPending();
	}

	private moveWordEndForward(count: number, bigWord: boolean): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const fromIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findWordEndForward(fullText, fromIndex, repeats, bigWord);
		this.moveCursorTo(this.indexToPos(fullText, targetIndex));
		this.resetPending();
	}

	private deleteBigWordBackward(count: number): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const fullText = lines.join("\n");
		const cursorIndex = this.posToIndex(lines, cursor);
		const targetIndex = this.findBigWordStartBackward(fullText, cursorIndex, repeats);
		const deleteEnd = cursorIndex;

		if (targetIndex >= deleteEnd) {
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const nextText = fullText.slice(0, targetIndex) + fullText.slice(deleteEnd);
			this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, targetIndex));
		});
		this.resetPending();
	}

	private findBigWordStartBackward(text: string, fromIndex: number, repeats: number): number {
		let index = Math.max(0, Math.min(fromIndex, text.length));
		const steps = Math.max(1, repeats);

		for (let step = 0; step < steps; step++) {
			if (index <= 0) {
				return 0;
			}

			let probe = index - 1;
			while (probe >= 0 && isWhitespaceChar(text[probe] ?? "")) {
				probe -= 1;
			}
			if (probe < 0) {
				return 0;
			}

			while (probe >= 0 && !isWhitespaceChar(text[probe] ?? "")) {
				probe -= 1;
			}
			index = probe + 1;
		}

		return index;
	}

	private deleteRangeInCurrentLine(startCol: number, endColExclusive: number): void {
		const cursor = this.getCursor();
		const lines = this.getLines();
		const currentLine = lines[cursor.line] ?? "";
		const lineLength = currentLine.length;
		const start = Math.max(0, Math.min(startCol, lineLength));
		const end = Math.max(start, Math.min(endColExclusive, lineLength));

		if (start >= end) {
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			lines[cursor.line] = currentLine.slice(0, start) + currentLine.slice(end);
			this.setTextAndMoveCursor(lines.join("\n"), { line: cursor.line, col: start });
		});
		this.resetPending();
	}

	private deleteCurrentLine(count: number): void {
		const cursor = this.getCursor();
		this.deleteLinesAt(cursor.line, Math.max(1, count));
	}

	private deleteToLineEnd(count: number): void {
		const repeats = Math.max(1, count);
		this.withTrackedEdit(() => {
			this.send(SEQ.deleteToEnd);
			for (let i = 1; i < repeats; i++) {
				this.send(SEQ.deleteToEnd);
				this.send(SEQ.deleteToEnd);
			}
		});
		this.resetPending();
	}

	private deleteToLineStart(_count: number): void {
		const cursor = this.getCursor();
		if (cursor.col <= 0) {
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const lines = this.getLines();
			const currentLine = lines[cursor.line] ?? "";
			lines[cursor.line] = currentLine.slice(cursor.col);
			this.setTextAndMoveCursor(lines.join("\n"), { line: cursor.line, col: 0 });
		});
		this.resetPending();
	}

	private deleteCharsBackward(count: number): void {
		const cursor = this.getCursor();
		if (cursor.col <= 0) {
			this.resetPending();
			return;
		}

		const deleteCount = Math.min(Math.max(1, count), cursor.col);
		this.withTrackedEdit(() => {
			const lines = this.getLines();
			const currentLine = lines[cursor.line] ?? "";
			const start = cursor.col - deleteCount;
			lines[cursor.line] = currentLine.slice(0, start) + currentLine.slice(cursor.col);
			this.setTextAndMoveCursor(lines.join("\n"), { line: cursor.line, col: start });
		});
		this.resetPending();
	}

	private deleteLinesDown(count: number): void {
		const cursor = this.getCursor();
		this.deleteLinesAt(cursor.line, Math.max(1, count) + 1);
	}

	private deleteLinesUp(count: number): void {
		const cursor = this.getCursor();
		const startLine = Math.max(0, cursor.line - Math.max(1, count));
		const linesToDelete = cursor.line - startLine + 1;
		this.deleteLinesAt(startLine, linesToDelete);
	}

	private deleteLinesAt(startLine: number, count: number): void {
		const deleteCount = Math.max(1, count);
		this.withTrackedEdit(() => {
			const lines = this.getLines();
			const clampedStart = Math.max(0, Math.min(startLine, lines.length - 1));
			const endExclusive = Math.min(lines.length, clampedStart + deleteCount);
			const remaining = [...lines.slice(0, clampedStart), ...lines.slice(endExclusive)];
			if (remaining.length === 0) {
				remaining.push("");
			}
			const nextLine = Math.max(0, Math.min(clampedStart, remaining.length - 1));
			this.setTextAndMoveCursor(remaining.join("\n"), { line: nextLine, col: 0 });
		});
		this.resetPending();
	}

	private moveToLastCharOnLine(): void {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		const lastCol = Math.max(0, line.length - 1);
		this.moveCursorTo({ line: cursor.line, col: lastCol });
		this.resetPending();
	}

	private moveToFirstNonBlank(): void {
		const { line } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		const firstNonBlank = this.getFirstNonBlankCol(currentLine);
		this.moveCursorTo({ line, col: firstNonBlank });
		this.resetPending();
	}

	private toggleCaseAtCursor(count: number): void {
		const repeats = Math.max(1, count);
		const cursor = this.getCursor();
		const lines = this.getLines();
		const currentLine = lines[cursor.line] ?? "";
		if (currentLine.length === 0) {
			this.resetPending();
			return;
		}
		// Clamp cursor to last valid position ($ may place cursor past end)
		const startCol = Math.min(cursor.col, currentLine.length - 1);
		const end = Math.min(startCol + repeats, currentLine.length);
		const segment = currentLine.slice(startCol, end);
		const toggled = this.transformCase(segment, "toggle");
		this.withTrackedEdit(() => {
			const nextLines = this.getLines();
			const line = nextLines[cursor.line] ?? "";
			nextLines[cursor.line] = `${line.slice(0, startCol)}${toggled}${line.slice(end)}`;
			this.setTextAndMoveCursor(nextLines.join("\n"), { line: cursor.line, col: Math.min(end, currentLine.length - 1) });
		});
		this.resetPending();
	}

	private substituteChars(count: number): void {
		const repeats = Math.max(1, count);
		this.captureDeleteToClipboard("charwise", () => {
			this.withTrackedEdit(() => {
				this.send(SEQ.deleteCharForward, repeats);
			});
		});
		this.enterInsertModeAtCurrentCursor();
	}

	private substituteLines(count: number): void {
		const repeats = Math.max(1, count);
		this.captureDeleteToClipboard("linewise", () => {
			this.withTrackedEdit(() => {
				const cursor = this.getCursor();
				const lines = this.getLines();
				const endLine = Math.min(lines.length, cursor.line + repeats);
				const remaining = [...lines.slice(0, cursor.line), "", ...lines.slice(endLine)];
				if (remaining.length === 0) remaining.push("");
				this.setTextAndMoveCursor(remaining.join("\n"), { line: cursor.line, col: 0 });
			});
		});
		this.enterInsertModeAtCurrentCursor();
	}

	private enterInsertAtFirstNonBlank(): void {
		const { line } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		const firstNonBlank = this.getFirstNonBlankCol(currentLine);
		this.send(SEQ.lineStart);
		if (firstNonBlank > 0) {
			this.send(SEQ.right, firstNonBlank);
		}
		this.enterInsertModeAtCurrentCursor(this.clonePos(this.getCursor()));
	}

	private enterInsertAtLineEnd(): void {
		this.send(SEQ.lineEnd);
		this.enterInsertModeAtCurrentCursor();
	}

	private openLineBelow(count: number): void {
		this.withTrackedEdit(() => {
			for (let i = 0; i < count; i++) {
				this.send(SEQ.lineEnd);
				this.send(SEQ.newLine);
			}
		});
		this.enterInsertModeAtCurrentCursor();
	}

	private openLineAbove(count: number): void {
		this.withTrackedEdit(() => {
			for (let i = 0; i < count; i++) {
				this.send(SEQ.lineStart);
				this.send(SEQ.newLine);
				this.send(SEQ.up);
			}
		});
		this.enterInsertModeAtCurrentCursor();
	}

	private joinWithNextLine(count: number): void {
		this.withTrackedEdit(() => {
			for (let i = 0; i < count; i++) {
				const cursor = this.getCursor();
				const lines = this.getLines();
				if (cursor.line >= lines.length - 1) {
					break;
				}

				const currentLine = lines[cursor.line] ?? "";
				const nextLine = lines[cursor.line + 1] ?? "";
				const trimmedNext = nextLine.replace(/^\s+/, "");
				const shouldInsertSpace =
					currentLine.length > 0 && trimmedNext.length > 0 && !/\s$/.test(currentLine);
				const joinCol = currentLine.length;

				// Replace current line + next line with joined version
				const joined = shouldInsertSpace ? `${currentLine} ${trimmedNext}` : `${currentLine}${trimmedNext}`;
				lines.splice(cursor.line, 2, joined);
				this.setTextAndMoveCursor(lines.join("\n"), { line: cursor.line, col: joinCol });
			}
		});
		this.resetPending();
	}

	private getVisualLineRange(): { startLine: number; endLine: number } | null {
		if (!this.visualAnchor) {
			return null;
		}
		const cursor = this.getCursor();
		return {
			startLine: Math.min(this.visualAnchor.line, cursor.line),
			endLine: Math.max(this.visualAnchor.line, cursor.line),
		};
	}

	private changeVisualLineSelection(): void {
		const range = this.getVisualLineRange();
		if (!range) {
			this.mode = "normal";
			this.visualAnchor = null;
			this.resetPending();
			return;
		}
		this.withTrackedEdit(() => {
			const lines = this.getLines();
			const nextLines = [...lines.slice(0, range.startLine), "", ...lines.slice(range.endLine + 1)];
			if (nextLines.length === 0) nextLines.push("");
			this.setTextAndMoveCursor(nextLines.join("\n"), { line: range.startLine, col: 0 });
		});
		this.mode = "normal";
		this.visualAnchor = null;
		this.resetPending();
	}

	private deleteVisualSelection(): void {
		const anchor = this.visualAnchor;
		if (!anchor) {
			this.mode = "normal";
			this.resetPending();
			return;
		}

		if (this.mode === "visual_line") {
			const range = this.getVisualLineRange();
			if (!range) {
				this.mode = "normal";
				this.visualAnchor = null;
				this.resetPending();
				return;
			}
			this.deleteLinesAt(range.startLine, range.endLine - range.startLine + 1);
			this.mode = "normal";
			this.visualAnchor = null;
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const cursor = this.getCursor();
			const lines = this.getLines();
			const fullText = lines.join("\n");

			let startIndex = this.posToIndex(lines, anchor);
			let endIndex = this.posToIndex(lines, cursor);

			if (endIndex < startIndex) {
				[startIndex, endIndex] = [endIndex, startIndex];
			}
			endIndex = Math.min(fullText.length, endIndex + 1);

			const nextText = fullText.slice(0, startIndex) + fullText.slice(endIndex);
			const nextPos = this.indexToPos(nextText, startIndex);
			this.setTextAndMoveCursor(nextText, nextPos);
		});

		this.mode = "normal";
		this.visualAnchor = null;
		this.resetPending();
	}

	private copyCurrentLine(): void {
		const cursor = this.getCursor();
		const lineText = this.getLines()[cursor.line] ?? "";
		this.writeClipboard(lineText, "linewise");
	}

	private copyVisualSelection(linewise: boolean): void {
		const anchor = this.visualAnchor;
		if (!anchor) {
			this.mode = "normal";
			this.resetPending();
			return;
		}

		const lines = this.getLines();
		const cursor = this.getCursor();
		const useLinewise = linewise || this.mode === "visual_line";
		if (useLinewise) {
			const startLine = Math.min(anchor.line, cursor.line);
			const endLine = Math.max(anchor.line, cursor.line);
			this.writeClipboard(lines.slice(startLine, endLine + 1).join("\n"), "linewise");
		} else {
			const fullText = lines.join("\n");
			let startIndex = this.posToIndex(lines, anchor);
			let endIndex = this.posToIndex(lines, cursor);
			if (endIndex < startIndex) {
				[startIndex, endIndex] = [endIndex, startIndex];
			}
			endIndex = Math.min(fullText.length, endIndex + 1);
			this.writeClipboard(fullText.slice(startIndex, endIndex), "charwise");
		}

		this.mode = "normal";
		this.visualAnchor = null;
		this.resetPending();
	}

	private pasteAtCursor(): void {
		const register = this.readClipboardRegister();
		if (!register) {
			this.resetPending();
			return;
		}

		if (register.type === "linewise") {
			this.withTrackedEdit(() => {
				const cursor = this.getCursor();
				const lines = this.getLines();
				const pasteLines = this.splitClipboardLines(register.text);
				const insertLine = Math.max(0, Math.min(cursor.line + 1, lines.length));
				const nextLines = [...lines.slice(0, insertLine), ...pasteLines, ...lines.slice(insertLine)];
				this.setTextAndMoveCursor(nextLines.join("\n"), { line: insertLine, col: 0 });
			});
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const cursor = this.getCursor();
			const lines = this.getLines();
			const fullText = lines.join("\n");
			const lineText = lines[cursor.line] ?? "";
			let insertIndex = this.posToIndex(lines, cursor);
			if (cursor.col < lineText.length) {
				insertIndex += 1;
			}

			const nextText = fullText.slice(0, insertIndex) + register.text + fullText.slice(insertIndex);
			const cursorIndex = insertIndex + Math.max(0, register.text.length - 1);
			this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, cursorIndex));
		});
		this.resetPending();
	}

	private pasteOverVisualSelection(): void {
		const anchor = this.visualAnchor;
		const register = this.readClipboardRegister();
		if (!anchor || !register) {
			this.mode = "normal";
			this.visualAnchor = null;
			this.resetPending();
			return;
		}

		if (this.mode === "visual_line") {
			const range = this.getVisualLineRange();
			if (!range) {
				this.mode = "normal";
				this.visualAnchor = null;
				this.resetPending();
				return;
			}

			this.withTrackedEdit(() => {
				const lines = this.getLines();
				const pasteLines = this.splitClipboardLines(register.text);
				const nextLines = [
					...lines.slice(0, range.startLine),
					...pasteLines,
					...lines.slice(range.endLine + 1),
				];
				const normalized = nextLines.length > 0 ? nextLines : [""];
				this.setTextAndMoveCursor(normalized.join("\n"), { line: range.startLine, col: 0 });
			});

			this.mode = "normal";
			this.visualAnchor = null;
			this.resetPending();
			return;
		}

		this.withTrackedEdit(() => {
			const cursor = this.getCursor();
			const lines = this.getLines();
			const fullText = lines.join("\n");

			let startIndex = this.posToIndex(lines, anchor);
			let endIndex = this.posToIndex(lines, cursor);
			if (endIndex < startIndex) {
				[startIndex, endIndex] = [endIndex, startIndex];
			}
			endIndex = Math.min(fullText.length, endIndex + 1);

			const nextText = fullText.slice(0, startIndex) + register.text + fullText.slice(endIndex);
			const cursorIndex = startIndex + Math.max(0, register.text.length - 1);
			this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, cursorIndex));
		});

		this.mode = "normal";
		this.visualAnchor = null;
		this.resetPending();
	}

	private splitClipboardLines(text: string): string[] {
		const normalized = text.replace(/\r\n/g, "\n");
		const lines = normalized.split("\n");
		if (lines.length > 1 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		return lines.length > 0 ? lines : [""];
	}

	private readClipboardRegister(): { text: string; type: RegisterType } | null {
		const systemText = this.readClipboardText();
		const text = systemText ?? this.clipboardFallback;
		if (!text) {
			return null;
		}

		let type: RegisterType = "charwise";
		if (systemText === null || text === this.clipboardFallback) {
			type = this.clipboardFallbackType;
		}
		if (type === "charwise" && text.endsWith("\n")) {
			type = "linewise";
		}
		return { text, type };
	}

	/** Returns true when no X11/Wayland display is available (e.g. headless server over SSH). */
	private static isHeadlessLinux(): boolean {
		return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.TERMUX_VERSION;
	}

	private static isWayland(): boolean {
		return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland";
	}

	private writeClipboard(text: string, type: RegisterType): void {
		this.clipboardFallback = text;
		this.clipboardFallbackType = type;

		// Always emit OSC 52 — works over SSH/mosh when the terminal supports it (kitty, iTerm2, etc.)
		const encoded = Buffer.from(text).toString("base64");
		process.stdout.write(`\x1b]52;c;${encoded}\x07`);

		// On headless Linux (SSH), skip native clipboard tools entirely — they can't work without a display.
		if (ModalEditor.isHeadlessLinux()) {
			return;
		}

		// Best-effort native clipboard write (suppress stderr to avoid TUI corruption).
		const options = { input: text, timeout: 5000, stdio: ["pipe" as IOType, "ignore" as IOType, "ignore" as IOType] };
		try {
			if (process.platform === "darwin") {
				execSync("pbcopy", options);
			} else if (process.platform === "win32") {
				execSync("clip", options);
			} else {
				if (process.env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
						return;
					} catch {
						// fall through
					}
				}
				if (ModalEditor.isWayland()) {
					try {
						execSync("which wl-copy", { stdio: "ignore", timeout: 5000 });
						const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
						proc.stdin.on("error", () => {}); // ignore EPIPE
						proc.stdin.write(text);
						proc.stdin.end();
						proc.unref();
					} catch {
						try {
							execSync("xclip -selection clipboard", options);
						} catch {
							execSync("xsel --clipboard --input", options);
						}
					}
				} else {
					try {
						execSync("xclip -selection clipboard", options);
					} catch {
						execSync("xsel --clipboard --input", options);
					}
				}
			}
		} catch {
			// Ignore — OSC 52 already emitted as fallback
		}
	}

	private readClipboardText(): string | null {
		// On headless Linux (SSH), native clipboard tools can't work — skip entirely.
		if (ModalEditor.isHeadlessLinux()) {
			return null;
		}

		// Suppress stderr on all execSync calls to avoid TUI corruption.
		const opts = { encoding: "utf8" as const, timeout: 5000, stdio: ["pipe" as IOType, "pipe" as IOType, "ignore" as IOType] };
		try {
			if (process.platform === "darwin") {
				return execSync("pbpaste", opts);
			}
			if (process.platform === "win32") {
				return execSync("powershell -NoProfile -Command Get-Clipboard", opts);
			}
			if (process.env.TERMUX_VERSION) {
				try {
					return execSync("termux-clipboard-get", opts);
				} catch {
					// fall through
				}
			}
			if (ModalEditor.isWayland()) {
				try {
					return execSync("wl-paste --no-newline", opts);
				} catch {
					// fall through
				}
			}
			try {
				return execSync("xclip -selection clipboard -o", opts);
			} catch {
				return execSync("xsel --clipboard --output", opts);
			}
		} catch {
			return null;
		}
	}

	private undo(): void {
		const previous = this.undoHistory.pop();
		if (!previous) {
			this.resetPending();
			return;
		}
		this.redoHistory.push(this.captureSnapshot());
		this.restoreSnapshotInNormalMode(previous);
		this.mode = "normal";
		this.clearInsertSession();
		this.visualAnchor = null;
		this.resetPending();
	}

	private redo(): void {
		const next = this.redoHistory.pop();
		if (!next) {
			this.resetPending();
			return;
		}
		this.undoHistory.push(this.captureSnapshot());
		this.restoreSnapshotInNormalMode(next);
		this.mode = "normal";
		this.clearInsertSession();
		this.visualAnchor = null;
		this.resetPending();
	}

	private captureSnapshot(): Snapshot {
		return {
			text: this.getText(),
			cursor: this.getCursor(),
			normalCursor: this.getCurrentNormalCursor(),
		};
	}

	private restoreSnapshot(snapshot: Snapshot): void {
		this.setTextAndMoveCursor(snapshot.text, snapshot.cursor);
	}

	private restoreSnapshotInNormalMode(snapshot: Snapshot): void {
		this.setTextAndMoveCursor(snapshot.text, snapshot.normalCursor);
	}

	private withTrackedEdit(edit: () => void): void {
		if (this.trackingDepth === 0) {
			this.trackingStartSnapshot = this.captureSnapshot();
		}
		this.trackingDepth += 1;
		try {
			edit();
		} finally {
			this.trackingDepth -= 1;
			if (this.trackingDepth === 0) {
				const before = this.trackingStartSnapshot;
				this.trackingStartSnapshot = null;
				if (!before) {
					return;
				}
				const after = this.captureSnapshot();
				if (before.text !== after.text) {
					this.undoHistory.push(before);
					this.redoHistory = [];
				}
			}
		}
	}

	private buildWrappedSegments(width: number): LayoutSegment[] {
		const lines = this.getLines();
		const cursor = this.getCursor();
		const segments: LayoutSegment[] = [];

		if (lines.length === 0) {
			return [{ logicalLine: 0, text: "", startCol: 0, endCol: 0, hasCursor: true, cursorPos: 0 }];
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			const isCurrentLine = i === cursor.line;
			const chunks = wordWrapLine(line, width);

			for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
				const chunk = chunks[chunkIndex]!;
				const isLastChunk = chunkIndex === chunks.length - 1;
				let hasCursor = false;
				let cursorPos = 0;

				if (isCurrentLine) {
					if (isLastChunk) {
						hasCursor = cursor.col >= chunk.startIndex;
						cursorPos = cursor.col - chunk.startIndex;
					} else {
						hasCursor = cursor.col >= chunk.startIndex && cursor.col < chunk.endIndex;
						if (hasCursor) {
							cursorPos = cursor.col - chunk.startIndex;
							if (cursorPos > chunk.text.length) {
								cursorPos = chunk.text.length;
							}
						}
					}
				}

				segments.push({
					logicalLine: i,
					text: chunk.text,
					startCol: chunk.startIndex,
					endCol: chunk.endIndex,
					hasCursor,
					cursorPos: hasCursor ? cursorPos : undefined,
				});
			}
		}

		if (segments.length === 0) {
			segments.push({ logicalLine: 0, text: "", startCol: 0, endCol: 0, hasCursor: true, cursorPos: 0 });
		}

		return segments;
	}

	private getLineOffsets(lines: string[]): number[] {
		const offsets: number[] = [];
		let offset = 0;
		for (let i = 0; i < lines.length; i++) {
			offsets.push(offset);
			offset += (lines[i] ?? "").length;
			offset += 1;
		}
		return offsets;
	}

	private getVisualSelectionRange(lines: string[]): { start: number; end: number } | null {
		if ((this.mode !== "visual" && this.mode !== "visual_line") || !this.visualAnchor) {
			return null;
		}

		const fullLen = lines.join("\n").length;
		if (this.mode === "visual_line") {
			const cursor = this.getCursor();
			const startLine = Math.min(this.visualAnchor.line, cursor.line);
			const endLine = Math.max(this.visualAnchor.line, cursor.line);
			const start = this.posToIndex(lines, { line: startLine, col: 0 });
			let end = this.posToIndex(lines, { line: endLine, col: (lines[endLine] ?? "").length });
			if (endLine < lines.length - 1) {
				end += 1;
			}
			return { start, end: Math.min(fullLen, end) };
		}

		const cursor = this.getCursor();
		const a = this.posToIndex(lines, this.visualAnchor);
		const c = this.posToIndex(lines, cursor);
		const start = Math.min(a, c);
		const end = Math.min(fullLen, Math.max(a, c) + 1);
		return { start, end };
	}

	private applyVisualHighlight(
		text: string,
		segment: LayoutSegment,
		lineOffsets: number[],
		range: { start: number; end: number } | null,
	): string {
		if (!range) {
			return text;
		}

		const lineOffset = lineOffsets[segment.logicalLine] ?? 0;
		const segmentStart = lineOffset + segment.startCol;
		const segmentEnd = lineOffset + segment.endCol;

		const overlapStart = Math.max(segmentStart, range.start);
		const overlapEnd = Math.min(segmentEnd, range.end);
		if (overlapStart >= overlapEnd) {
			return text;
		}

		const localStart = overlapStart - segmentStart;
		const localEnd = overlapEnd - segmentStart;
		return `${text.slice(0, localStart)}\x1b[7m${text.slice(localStart, localEnd)}\x1b[0m${text.slice(localEnd)}`;
	}

	private insertMarkerAtCursorColumn(text: string, cursorCol: number, plainLength: number): string {
		const clampedCol = Math.max(0, Math.min(cursorCol, plainLength));
		let textIndex = 0;
		let plainIndex = 0;

		while (textIndex < text.length && plainIndex < clampedCol) {
			if (text[textIndex] === "\x1b") {
				const csiMatch = text.slice(textIndex).match(/^\x1b\[[0-9;]*m/);
				if (csiMatch) {
					textIndex += csiMatch[0].length;
					continue;
				}
			}
			textIndex += 1;
			plainIndex += 1;
		}

		return `${text.slice(0, textIndex)}${CURSOR_MARKER}${text.slice(textIndex)}`;
	}

	private renderVisualMode(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		// Keep Editor's internal wrap width in sync while visual mode uses a custom renderer.
		// Cursor movement handlers (up/down, page keys, etc.) depend on this value.
		(this as unknown as { lastWidth: number }).lastWidth = layoutWidth;

		const segments = this.buildWrappedSegments(layoutWidth);
		const cursorLineIndex = Math.max(0, segments.findIndex((segment) => segment.hasCursor));

		const maxVisibleLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		if (cursorLineIndex < this.visualScrollOffset) {
			this.visualScrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.visualScrollOffset + maxVisibleLines) {
			this.visualScrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		const maxScrollOffset = Math.max(0, segments.length - maxVisibleLines);
		this.visualScrollOffset = Math.max(0, Math.min(this.visualScrollOffset, maxScrollOffset));

		const visibleSegments = segments.slice(this.visualScrollOffset, this.visualScrollOffset + maxVisibleLines);
		const lines = this.getLines();
		const offsets = this.getLineOffsets(lines);
		const selection = this.getVisualSelectionRange(lines);

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;
		const horizontal = this.borderColor("─");

		if (this.visualScrollOffset > 0) {
			const indicator = `─── ↑ ${this.visualScrollOffset} more `;
			const remaining = width - visibleWidth(indicator);
			result.push(this.borderColor(indicator + "─".repeat(Math.max(0, remaining))));
		} else {
			result.push(horizontal.repeat(width));
		}

		const emitCursorMarker = this.focused;
		for (const segment of visibleSegments) {
			let highlighted = this.applyVisualHighlight(segment.text, segment, offsets, selection);
			if (emitCursorMarker && segment.hasCursor) {
				highlighted = this.insertMarkerAtCursorColumn(highlighted, segment.cursorPos ?? 0, segment.text.length);
			}
			const lineWidth = visibleWidth(highlighted);
			const padding = " ".repeat(Math.max(0, contentWidth - lineWidth));
			result.push(`${leftPadding}${highlighted}${padding}${rightPadding}`);
		}

		const linesBelow = segments.length - (this.visualScrollOffset + visibleSegments.length);
		if (linesBelow > 0) {
			const indicator = `─── ↓ ${linesBelow} more `;
			const remaining = width - visibleWidth(indicator);
			result.push(this.borderColor(indicator + "─".repeat(Math.max(0, remaining))));
		} else {
			result.push(horizontal.repeat(width));
		}

		return result;
	}

	private posToIndex(lines: string[], pos: Pos): number {
		let idx = 0;
		for (let i = 0; i < pos.line; i++) {
			idx += (lines[i] ?? "").length;
			idx += 1;
		}
		return idx + pos.col;
	}

	private indexToPos(text: string, index: number): Pos {
		const clamped = Math.max(0, Math.min(index, text.length));
		const lines = text.split("\n");
		let remaining = clamped;
		for (let line = 0; line < lines.length; line++) {
			const len = (lines[line] ?? "").length;
			if (remaining <= len) {
				return { line, col: remaining };
			}
			remaining -= len + 1;
		}
		const lastLine = Math.max(0, lines.length - 1);
		return { line: lastLine, col: (lines[lastLine] ?? "").length };
	}

	private moveCursorTo(pos: Pos, options: { preservePreferredCol?: boolean } = {}): void {
		const lines = this.getLines();
		const maxLine = Math.max(0, lines.length - 1);
		const targetLine = Math.max(0, Math.min(pos.line, maxLine));
		const lineText = lines[targetLine] ?? "";
		const targetCol = Math.max(0, Math.min(pos.col, this.getModalLineMaxCol(lineText)));

		if (!options.preservePreferredCol) {
			this.clearModalPreferredCol();
		}

		const current = this.getCursor();
		if (current.line > targetLine) this.send(SEQ.up, current.line - targetLine);
		if (current.line < targetLine) this.send(SEQ.down, targetLine - current.line);
		this.send(SEQ.lineStart);
		this.send(SEQ.right, targetCol);
	}

	private setTextAndMoveCursor(text: string, pos: Pos): void {
		this.setText(text);
		this.clearModalPreferredCol();
		const lines = this.getLines();
		const maxLine = Math.max(0, lines.length - 1);
		const targetLine = Math.max(0, Math.min(pos.line, maxLine));
		const targetCol = Math.max(0, Math.min(pos.col, (lines[targetLine] ?? "").length));

		const current = this.getCursor();
		this.send(SEQ.lineStart);
		if (current.line > targetLine) {
			this.send(SEQ.up, current.line - targetLine);
		} else if (current.line < targetLine) {
			this.send(SEQ.down, targetLine - current.line);
		}
		this.send(SEQ.lineStart);
		this.send(SEQ.right, targetCol);
	}

	private send(seq: string, count: number = 1): void {
		if (count <= 0) {
			return;
		}
		for (let i = 0; i < count; i++) {
			super.handleInput(seq);
		}
	}

	private hasPendingCommand(): boolean {
		return (
			this.pendingCount.length > 0 ||
			this.pendingOperator !== null ||
			this.pendingFind !== null ||
			this.pendingG ||
			this.pendingReplace ||
			this.pendingTextObjectPrefix !== null
		);
	}

	private consumeCount(defaultValue: number = 1): number {
		const parsed = this.pendingCount.length > 0 ? Number.parseInt(this.pendingCount, 10) : defaultValue;
		this.pendingCount = "";
		if (!Number.isFinite(parsed) || parsed <= 0) {
			return defaultValue;
		}
		return parsed;
	}

	private resetPending(): void {
		this.pendingCount = "";
		this.pendingOperator = null;
		this.pendingOperatorCount = 1;
		this.pendingFind = null;
		this.pendingG = false;
		this.pendingReplace = false;
		this.pendingTextObjectPrefix = null;
	}

	private getModeBorderColor(base: (text: string) => string): (text: string) => string {
		const themeRef = activeTheme;
		if (!themeRef) {
			return base;
		}
		if (this.mode === "normal") {
			return (text: string) => themeRef.fg("accent", text);
		}
		if (this.mode === "visual" || this.mode === "visual_line") {
			return (text: string) => themeRef.fg("warning", text);
		}
		// Insert mode keeps the default app/editor border color behavior
		return base;
	}

	render(width: number): string[] {
		const previousBorderColor = this.borderColor;
		const modeBorderColor = this.getModeBorderColor(previousBorderColor);
		this.borderColor = modeBorderColor;
		const lines = this.mode === "visual" || this.mode === "visual_line" ? this.renderVisualMode(width) : super.render(width);
		this.borderColor = previousBorderColor;
		if (lines.length === 0) return lines;

		let label = " INSERT ";
		if (this.mode === "normal") {
			label = " NORMAL ";
		} else if (this.mode === "visual") {
			label = " VISUAL ";
		} else if (this.mode === "visual_line") {
			label = " VISUAL LINE ";
		}

		if (this.mode !== "insert") {
			const pending = `${this.pendingOperator ?? ""}${this.pendingG ? "g" : ""}${this.pendingFind ?? ""}${this.pendingTextObjectPrefix ?? ""}${this.pendingCount}${this.pendingReplace ? "r" : ""}`;
			if (pending.length > 0) {
				label = `${label.slice(0, -1)} [${pending}] `;
			}
		}

		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + modeBorderColor(label);
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		activeTheme = ctx.ui.theme;
		ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
	});
}
