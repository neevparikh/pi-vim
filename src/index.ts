/**
 * Modal Editor - vim-like modal editing extension
 *
 * - Escape: insert -> normal mode (in normal mode, aborts agent when no pending command)
 * - Modes: normal, insert, visual
 * - Counts: e.g. 2l, 3w, 2dd
 * - Motions: h j k l, 0, $, w, b, e/E, f<char>, t<char>
 * - Editing: x, d + motion, dd, D, i, I, a, A, o, O, J
 * - Undo/redo: u / U
 * - Clipboard: y/Y copy, p paste (works in visual mode too)
 */

import { execSync } from "node:child_process";
import { copyToClipboard, CustomEditor, type ExtensionAPI, type Theme } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

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

type Mode = "normal" | "insert" | "visual";
type PendingOperator = "d" | null;
type PendingFind = "f" | "t" | null;

interface Pos {
	line: number;
	col: number;
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
	private visualAnchor: Pos | null = null;
	private visualScrollOffset = 0;
	private clipboardFallback = "";
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

			if (this.mode === "visual") {
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
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.applyFind(data);
			} else {
				this.resetPending();
			}
			return;
		}

		if (data.length === 1 && data >= "0" && data <= "9") {
			if (data === "0" && this.pendingCount.length === 0 && !this.pendingOperator) {
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

		if (this.mode === "visual") {
			this.handleVisualInput(data);
			return;
		}

		this.handleNormalInput(data);
	}

	private handleNormalInput(data: string): void {
		if (matchesKey(data, "u")) {
			this.undo();
			return;
		}
		if (matchesKey(data, "shift+u")) {
			this.redo();
			return;
		}
		if (matchesKey(data, "y") || matchesKey(data, "shift+y")) {
			this.copyCurrentLine();
			this.resetPending();
			return;
		}
		if (matchesKey(data, "p")) {
			this.pasteAtCursor();
			return;
		}
		if (matchesKey(data, "shift+e")) {
			this.send(SEQ.wordForward, this.consumeCount());
			return;
		}

		switch (data) {
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
			case "b":
				this.send(SEQ.wordBackward, this.consumeCount());
				return;
			case "e":
				this.send(SEQ.wordForward, this.consumeCount());
				return;
			case "f":
				this.pendingFind = "f";
				return;
			case "t":
				this.pendingFind = "t";
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
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					this.resetPending();
					return;
				}
				this.resetPending();
				super.handleInput(data);
				return;
		}
	}

	private handleVisualInput(data: string): void {
		if (matchesKey(data, "u")) {
			this.undo();
			return;
		}
		if (matchesKey(data, "shift+u")) {
			this.redo();
			return;
		}
		if (matchesKey(data, "y")) {
			this.copyVisualSelection(false);
			return;
		}
		if (matchesKey(data, "shift+y")) {
			this.copyVisualSelection(true);
			return;
		}
		if (matchesKey(data, "p")) {
			this.pasteOverVisualSelection();
			return;
		}
		if (matchesKey(data, "shift+e")) {
			this.send(SEQ.wordForward, this.consumeCount());
			return;
		}

		switch (data) {
			case "v":
				this.mode = "normal";
				this.visualAnchor = null;
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
			case "b":
				this.send(SEQ.wordBackward, this.consumeCount());
				return;
			case "e":
				this.send(SEQ.wordForward, this.consumeCount());
				return;
			case "f":
				this.pendingFind = "f";
				return;
			case "t":
				this.pendingFind = "t";
				return;
			default:
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					this.resetPending();
					return;
				}
				this.resetPending();
				super.handleInput(data);
				return;
		}
	}

	private handleDeleteOperator(data: string): void {
		if (matchesKey(data, "shift+e")) {
			const motionCount = this.consumeCount();
			const total = Math.max(1, this.pendingOperatorCount * motionCount);
			this.withTrackedEdit(() => {
				this.send(SEQ.deleteWordForward, total);
			});
			this.resetPending();
			return;
		}

		switch (data) {
			case "d": {
				const motionCount = this.consumeCount();
				const totalLines = Math.max(1, this.pendingOperatorCount * motionCount);
				this.deleteCurrentLine(totalLines);
				return;
			}
			case "w":
			case "e": {
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
			case "l": {
				const motionCount = this.consumeCount();
				const total = Math.max(1, this.pendingOperatorCount * motionCount);
				this.withTrackedEdit(() => {
					this.send(SEQ.deleteCharForward, total);
				});
				this.resetPending();
				return;
			}
			case "f":
				this.pendingFind = "f";
				return;
			case "t":
				this.pendingFind = "t";
				return;
			default:
				this.resetPending();
				return;
		}
	}

	private applyFind(targetChar: string): void {
		const findType = this.pendingFind;
		const operator = this.pendingOperator;
		const occurrenceCount = this.consumeCount();
		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";

		let foundIndex = -1;
		let from = col + 1;
		const searchRepeats = Math.max(1, occurrenceCount);

		for (let i = 0; i < searchRepeats; i++) {
			foundIndex = currentLine.indexOf(targetChar, from);
			if (foundIndex < 0) {
				this.resetPending();
				return;
			}
			from = foundIndex + 1;
		}

		if (!findType) {
			this.resetPending();
			return;
		}

		if (operator === "d") {
			const opCount = Math.max(1, this.pendingOperatorCount);
			const totalDeletesForOneMotion =
				findType === "f" ? Math.max(0, foundIndex - col + 1) : Math.max(0, foundIndex - col);
			this.withTrackedEdit(() => {
				this.send(SEQ.deleteCharForward, totalDeletesForOneMotion * opCount);
			});
			this.resetPending();
			return;
		}

		const targetCol = findType === "f" ? foundIndex : Math.max(col, foundIndex - 1);
		const steps = Math.max(0, targetCol - col);
		this.send(SEQ.right, steps);
		this.resetPending();
	}

	private deleteCurrentLine(count: number): void {
		this.withTrackedEdit(() => {
			this.send(SEQ.lineStart);
			for (let i = 0; i < count; i++) {
				this.send(SEQ.deleteToEnd);
				this.send(SEQ.deleteToEnd);
			}
		});
		this.resetPending();
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
			}
		});
		this.mode = "insert";
		this.resetPending();
	}

	private joinWithNextLine(count: number): void {
		this.withTrackedEdit(() => {
			for (let i = 0; i < count; i++) {
				this.send(SEQ.lineEnd);
				this.send(SEQ.deleteToEnd);
			}
		});
		this.resetPending();
	}

	private deleteVisualSelection(): void {
		const anchor = this.visualAnchor;
		if (!anchor) {
			this.mode = "normal";
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
		this.writeClipboard(lineText);
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
		if (linewise) {
			const startLine = Math.min(anchor.line, cursor.line);
			const endLine = Math.max(anchor.line, cursor.line);
			this.writeClipboard(lines.slice(startLine, endLine + 1).join("\n"));
		} else {
			const fullText = lines.join("\n");
			let startIndex = this.posToIndex(lines, anchor);
			let endIndex = this.posToIndex(lines, cursor);
			if (endIndex < startIndex) {
				[startIndex, endIndex] = [endIndex, startIndex];
			}
			endIndex = Math.min(fullText.length, endIndex + 1);
			this.writeClipboard(fullText.slice(startIndex, endIndex));
		}

		this.mode = "normal";
		this.visualAnchor = null;
		this.resetPending();
	}

	private pasteAtCursor(): void {
		const clipboardText = this.readClipboardText() ?? this.clipboardFallback;
		if (!clipboardText) {
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

			const nextText = fullText.slice(0, insertIndex) + clipboardText + fullText.slice(insertIndex);
			const cursorIndex = insertIndex + Math.max(0, clipboardText.length - 1);
			this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, cursorIndex));
		});
		this.resetPending();
	}

	private pasteOverVisualSelection(): void {
		const anchor = this.visualAnchor;
		const clipboardText = this.readClipboardText() ?? this.clipboardFallback;
		if (!anchor || !clipboardText) {
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

			const nextText = fullText.slice(0, startIndex) + clipboardText + fullText.slice(endIndex);
			const cursorIndex = startIndex + Math.max(0, clipboardText.length - 1);
			this.setTextAndMoveCursor(nextText, this.indexToPos(nextText, cursorIndex));
		});

		this.mode = "normal";
		this.visualAnchor = null;
		this.resetPending();
	}

	private writeClipboard(text: string): void {
		this.clipboardFallback = text;
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
		if (this.mode !== "visual" || !this.visualAnchor) {
			return null;
		}
		const cursor = this.getCursor();
		const fullLen = lines.join("\n").length;
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

	private renderVisualMode(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

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
				highlighted = `${CURSOR_MARKER}${highlighted}`;
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
		const repeats = Math.max(1, count);
		for (let i = 0; i < repeats; i++) {
			super.handleInput(seq);
		}
	}

	private hasPendingCommand(): boolean {
		return this.pendingCount.length > 0 || this.pendingOperator !== null || this.pendingFind !== null;
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
	}

	private getModeBorderColor(base: (text: string) => string): (text: string) => string {
		const themeRef = activeTheme;
		if (!themeRef) {
			return base;
		}
		if (this.mode === "normal") {
			return (text: string) => themeRef.fg("accent", text);
		}
		if (this.mode === "visual") {
			return (text: string) => themeRef.fg("warning", text);
		}
		// Insert mode keeps the default app/editor border color behavior
		return base;
	}

	render(width: number): string[] {
		const previousBorderColor = this.borderColor;
		const modeBorderColor = this.getModeBorderColor(previousBorderColor);
		this.borderColor = modeBorderColor;
		const lines = this.mode === "visual" ? this.renderVisualMode(width) : super.render(width);
		this.borderColor = previousBorderColor;
		if (lines.length === 0) return lines;

		let label = " INSERT ";
		if (this.mode === "normal") {
			label = " NORMAL ";
		} else if (this.mode === "visual") {
			label = " VISUAL ";
		}

		if (this.mode !== "insert") {
			const pending = `${this.pendingOperator ?? ""}${this.pendingFind ?? ""}${this.pendingCount}`;
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
