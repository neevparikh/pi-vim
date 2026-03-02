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

import { execSync } from "node:child_process";
import { copyToClipboard, CustomEditor, type ExtensionAPI, type Theme } from "@mariozechner/pi-coding-agent";
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
type PendingOperator = "d" | null;
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
	private lastFindCommand: LastFindCommand | null = null;
	private visualAnchor: Pos | null = null;
	private visualScrollOffset = 0;
	private clipboardFallback = "";
	private clipboardFallbackType: RegisterType = "charwise";
	private undoHistory: Snapshot[] = [];
	private redoHistory: Snapshot[] = [];
	private trackingDepth = 0;
	private trackingStartSnapshot: Snapshot | null = null;

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
				this.resetPending();
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
			this.withTrackedEdit(() => {
				super.handleInput(data);
			});
			return;
		}

		if (this.pendingFind) {
			const targetChar = this.getPrintableInputChar(data);
			if (targetChar !== null) {
				this.applyFind(targetChar);
			} else {
				this.resetPending();
			}
			return;
		}

		if (this.pendingOperator === "d" && data === "0" && this.pendingCount.length === 0) {
			this.handleDeleteOperator(data);
			return;
		}

		if (data.length === 1 && data >= "0" && data <= "9") {
			if (data === "0" && this.pendingCount.length === 0 && !this.pendingOperator && !this.pendingG) {
				this.send(SEQ.lineStart);
				this.resetPending();
				return;
			}
			this.pendingCount += data;
			return;
		}

		if (this.pendingOperator === "d") {
			this.handleDeleteOperator(data);
			return;
		}

		if (this.mode === "visual" || this.mode === "visual_line") {
			this.handleVisualInput(data);
			return;
		}

		this.handleNormalInput(data);
	}

	private handleNormalInput(data: string): void {
		const printable = this.getPrintableInputChar(data);
		if (matchesKey(data, "u")) {
			this.undo();
			return;
		}
		if (matchesKey(data, "shift+u") || printable === "U") {
			this.redo();
			return;
		}
		if (matchesKey(data, "y") || matchesKey(data, "shift+y") || printable === "Y") {
			this.copyCurrentLine();
			this.resetPending();
			return;
		}
		if (matchesKey(data, "p")) {
			this.pasteAtCursor();
			return;
		}
		if ((matchesKey(data, "shift+e") || printable === "E") && !this.pendingG) {
			this.send(SEQ.wordForward, this.consumeCount());
			return;
		}
		if (data === "{" || matchesKey(data, "{") || matchesKey(data, "shift+[")) {
			this.moveParagraphBackward(this.consumeCount());
			return;
		}
		if (data === "}" || matchesKey(data, "}") || matchesKey(data, "shift+]")) {
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
				this.send(SEQ.left, this.consumeCount());
				return;
			case "j":
				this.send(SEQ.down, this.consumeCount());
				return;
			case "k":
				this.send(SEQ.up, this.consumeCount());
				return;
			case "l":
				this.send(SEQ.right, this.consumeCount());
				return;
			case "$":
				this.send(SEQ.lineEnd);
				this.resetPending();
				return;
			case "w":
				this.send(SEQ.wordForward, this.consumeCount());
				return;
			case "W":
				this.moveBigWordForward(this.consumeCount());
				return;
			case "b":
				this.send(SEQ.wordBackward, this.consumeCount());
				return;
			case "B":
				this.moveBigWordBackward(this.consumeCount());
				return;
			case "e":
				this.send(SEQ.wordForward, this.consumeCount());
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
				this.withTrackedEdit(() => {
					this.send(SEQ.deleteCharForward, this.consumeCount());
				});
				return;
			case "d":
				this.pendingOperator = "d";
				this.pendingOperatorCount = this.consumeCount();
				return;
			case "D":
				this.deleteToLineEnd(this.consumeCount());
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
				this.mode = "insert";
				this.resetPending();
				return;
			case "I":
				this.enterInsertAtFirstNonBlank();
				return;
			case "a":
				this.send(SEQ.right);
				this.mode = "insert";
				this.resetPending();
				return;
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
			this.send(SEQ.wordForward, this.consumeCount());
			return;
		}
		if (data === "{" || matchesKey(data, "{") || matchesKey(data, "shift+[")) {
			this.moveParagraphBackward(this.consumeCount());
			return;
		}
		if (data === "}" || matchesKey(data, "}") || matchesKey(data, "shift+]")) {
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
				this.deleteVisualSelection();
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
				this.send(SEQ.left, this.consumeCount());
				return;
			case "j":
				this.send(SEQ.down, this.consumeCount());
				return;
			case "k":
				this.send(SEQ.up, this.consumeCount());
				return;
			case "l":
				this.send(SEQ.right, this.consumeCount());
				return;
			case "$":
				this.send(SEQ.lineEnd);
				this.resetPending();
				return;
			case "w":
				this.send(SEQ.wordForward, this.consumeCount());
				return;
			case "W":
				this.moveBigWordForward(this.consumeCount());
				return;
			case "b":
				this.send(SEQ.wordBackward, this.consumeCount());
				return;
			case "B":
				this.moveBigWordBackward(this.consumeCount());
				return;
			case "e":
				this.send(SEQ.wordForward, this.consumeCount());
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

	private handleDeleteOperator(data: string): void {
		const printable = this.getPrintableInputChar(data);
		if ((matchesKey(data, "shift+e") || matchesKey(data, "shift+w") || printable === "E" || printable === "W") && !this.pendingG) {
			const motionCount = this.consumeCount();
			const total = Math.max(1, this.pendingOperatorCount * motionCount);
			this.withTrackedEdit(() => {
				this.send(SEQ.deleteWordForward, total);
			});
			this.resetPending();
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
				this.deleteCurrentLine(totalLines);
				return;
			}
			case "w":
			case "e":
			case "W": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.withTrackedEdit(() => {
					this.send(SEQ.deleteWordForward, total);
				});
				this.resetPending();
				return;
			}
			case "b": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.withTrackedEdit(() => {
					this.send(SEQ.deleteWordBackward, total);
				});
				this.resetPending();
				return;
			}
			case "B": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.deleteBigWordBackward(total);
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
				this.deleteToMatchingPair();
				return;
			case "l": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.withTrackedEdit(() => {
					this.send(SEQ.deleteCharForward, total);
				});
				this.resetPending();
				return;
			}
			case "h": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.deleteCharsBackward(total);
				return;
			}
			case "$": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.deleteToLineEnd(total);
				return;
			}
			case "0": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.deleteToLineStart(total);
				return;
			}
			case "j": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.deleteLinesDown(total);
				return;
			}
			case "k": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.deleteLinesUp(total);
				return;
			}
			default:
				this.resetPending();
				return;
		}
	}

	private handlePendingGMotion(command: string): void {
		switch (command) {
			case "e":
				this.moveWordEndBackward(this.consumeCount(), false);
				return;
			case "E":
				this.moveWordEndBackward(this.consumeCount(), true);
				return;
			default:
				this.resetPending();
				return;
		}
	}

	private handlePendingGDeleteMotion(command: string): void {
		switch (command) {
			case "e": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.deleteToWordEndBackward(total, false);
				return;
			}
			case "E": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.deleteToWordEndBackward(total, true);
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
		if (matchesKey(data, "shift+[")) return "{";
		if (matchesKey(data, "shift+]")) return "}";

		if (matchesKey(data, "shift+b")) return "B";
		if (matchesKey(data, "shift+d")) return "D";
		if (matchesKey(data, "shift+i")) return "I";
		if (matchesKey(data, "shift+a")) return "A";
		if (matchesKey(data, "shift+o")) return "O";
		if (matchesKey(data, "shift+j")) return "J";
		if (matchesKey(data, "shift+e")) return "E";
		if (matchesKey(data, "shift+w")) return "W";

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
				this.deleteRangeInCurrentLine(targetStart, deleteEnd);
				return;
			}

			const totalDeletesForMotion =
				findType === "f" ? Math.max(0, foundIndex - col + 1) : Math.max(0, foundIndex - col);
			this.withTrackedEdit(() => {
				this.send(SEQ.deleteCharForward, totalDeletesForMotion);
			});
			this.resetPending();
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
			while (probe < lines.length && !this.isBlankLine(lines[probe] ?? "")) {
				probe += 1;
			}
			while (probe < lines.length && this.isBlankLine(lines[probe] ?? "")) {
				probe += 1;
			}
			if (probe >= lines.length) {
				targetLine = Math.max(0, lines.length - 1);
				break;
			}
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
			while (probe >= 0 && this.isBlankLine(lines[probe] ?? "")) {
				probe -= 1;
			}
			if (probe < 0) {
				targetLine = 0;
				break;
			}
			while (probe >= 0 && !this.isBlankLine(lines[probe] ?? "")) {
				probe -= 1;
			}
			targetLine = Math.max(0, probe + 1);
		}

		this.moveCursorTo({ line: targetLine, col: 0 });
		this.resetPending();
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

		if (!openingToClosing[ch] && !closingToOpening[ch] && index > 0) {
			index -= 1;
			ch = text[index] ?? "";
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

	private enterInsertAtFirstNonBlank(): void {
		const { line } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		const firstNonBlank = currentLine.search(/\S/);
		this.send(SEQ.lineStart);
		if (firstNonBlank > 0) {
			this.send(SEQ.right, firstNonBlank);
		}
		this.mode = "insert";
		this.resetPending();
	}

	private enterInsertAtLineEnd(): void {
		this.send(SEQ.lineEnd);
		this.mode = "insert";
		this.resetPending();
	}

	private openLineBelow(count: number): void {
		this.withTrackedEdit(() => {
			for (let i = 0; i < count; i++) {
				this.send(SEQ.lineEnd);
				this.send(SEQ.newLine);
			}
		});
		this.mode = "insert";
		this.resetPending();
	}

	private openLineAbove(count: number): void {
		this.withTrackedEdit(() => {
			for (let i = 0; i < count; i++) {
				this.send(SEQ.lineStart);
				this.send(SEQ.newLine);
				this.send(SEQ.up);
			}
		});
		this.mode = "insert";
		this.resetPending();
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
				const shouldInsertSpace =
					currentLine.length > 0 && nextLine.length > 0 && !/\s$/.test(currentLine) && !/^\s/.test(nextLine);

				this.send(SEQ.lineEnd);
				this.send(SEQ.deleteToEnd);
				if (shouldInsertSpace) {
					super.handleInput(" ");
				}
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

	private writeClipboard(text: string, type: RegisterType): void {
		this.clipboardFallback = text;
		this.clipboardFallbackType = type;
		copyToClipboard(text);
	}

	private readClipboardText(): string | null {
		try {
			if (process.platform === "darwin") {
				return execSync("pbpaste", { encoding: "utf8", timeout: 5000 });
			}
			if (process.platform === "win32") {
				return execSync("powershell -NoProfile -Command Get-Clipboard", { encoding: "utf8", timeout: 5000 });
			}
			if (process.env.TERMUX_VERSION) {
				try {
					return execSync("termux-clipboard-get", { encoding: "utf8", timeout: 5000 });
				} catch {
					// fall through
				}
			}
			if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
				try {
					return execSync("wl-paste --no-newline", { encoding: "utf8", timeout: 5000 });
				} catch {
					// fall through
				}
			}
			try {
				return execSync("xclip -selection clipboard -o", { encoding: "utf8", timeout: 5000 });
			} catch {
				return execSync("xsel --clipboard --output", { encoding: "utf8", timeout: 5000 });
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
		this.restoreSnapshot(previous);
		this.mode = "normal";
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
		this.restoreSnapshot(next);
		this.mode = "normal";
		this.visualAnchor = null;
		this.resetPending();
	}

	private captureSnapshot(): Snapshot {
		return {
			text: this.getText(),
			cursor: this.getCursor(),
		};
	}

	private restoreSnapshot(snapshot: Snapshot): void {
		this.setTextAndMoveCursor(snapshot.text, snapshot.cursor);
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

	private moveCursorTo(pos: Pos): void {
		const lines = this.getLines();
		const maxLine = Math.max(0, lines.length - 1);
		const targetLine = Math.max(0, Math.min(pos.line, maxLine));
		const targetCol = Math.max(0, Math.min(pos.col, (lines[targetLine] ?? "").length));

		const current = this.getCursor();
		if (current.line > targetLine) this.send(SEQ.up, current.line - targetLine);
		if (current.line < targetLine) this.send(SEQ.down, targetLine - current.line);
		this.send(SEQ.lineStart);
		this.send(SEQ.right, targetCol);
	}

	private setTextAndMoveCursor(text: string, pos: Pos): void {
		this.setText(text);
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
		return this.pendingCount.length > 0 || this.pendingOperator !== null || this.pendingFind !== null || this.pendingG;
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
			const pending = `${this.pendingOperator ?? ""}${this.pendingG ? "g" : ""}${this.pendingFind ?? ""}${this.pendingCount}`;
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
