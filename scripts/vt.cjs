/**
 * Minimal VT100 screen emulator — just enough to assert what a real terminal
 * RENDERS from our escape sequences (ConPTY re-encodes sequences, so asserting
 * on the raw byte stream is not meaningful; the rendered screen is).
 *
 * Supported: printable chars, \r \n, CSI A/B/C/D/H, CSI J/K/L/M/S/T, CSI r
 * (DECSTBM margins), ESC 7/8 (save/restore cursor). Everything else is skipped.
 */
class VT {
	constructor(rows, cols) {
		this.rows = rows;
		this.cols = cols;
		this.screen = Array.from({ length: rows }, () => new Array(cols).fill(" "));
		this.x = 0;
		this.y = 0;
		this.saved = { x: 0, y: 0 };
		this.top = 0;
		this.bottom = rows - 1;
	}

	/** Render the screen to plain-text lines (trailing spaces kept). */
	text() {
		return this.screen.map((r) => r.join(""));
	}

	line(n) {
		return this.text()[n].trimEnd();
	}

	feed(data) {
		let i = 0;
		while (i < data.length) {
			const ch = data[i];
			if (ch === "\x1b") {
				i = this.escape(data, i);
			} else if (ch === "\r") {
				this.x = 0;
				i++;
			} else if (ch === "\n") {
				this.feedNewline();
				i++;
			} else if (ch === "\b") {
				this.x = Math.max(0, this.x - 1);
				i++;
			} else if (ch >= " ") {
				this.put(ch);
				i++;
			} else {
				i++; // swallow other control chars
			}
		}
	}

	put(ch) {
		if (this.y < 0 || this.y >= this.rows || this.x >= this.cols) return;
		this.screen[this.y][this.x] = ch;
		this.x++;
		if (this.x >= this.cols) {
			this.x = 0;
			this.feedNewline();
		}
	}

	feedNewline() {
		if (this.y === this.bottom) {
			this.scrollUp(1);
		} else if (this.y < this.rows - 1) {
			this.y++;
		}
	}

	scrollUp(n) {
		for (let k = 0; k < n; k++) {
			this.screen.splice(this.top, 1);
			this.screen.splice(this.bottom, 0, new Array(this.cols).fill(" "));
		}
	}

	scrollDown(n) {
		for (let k = 0; k < n; k++) {
			this.screen.splice(this.bottom, 1);
			this.screen.splice(this.top, 0, new Array(this.cols).fill(" "));
		}
	}

	escape(data, i) {
		const next = data[i + 1];
		// OSC (ESC ] ... BEL / ST): terminal title etc. — consumed, never printed
		if (next === "]") {
			const bel = data.indexOf("\x07", i + 2);
			if (bel !== -1) return bel + 1;
			const st = data.indexOf("\x1b\\", i + 2);
			if (st !== -1) return st + 2;
			return data.length; // unterminated — drop the rest of this chunk
		}
		if (next === "7") {
			this.saved = { x: this.x, y: this.y };
			return i + 2;
		}
		if (next === "8") {
			this.x = this.saved.x;
			this.y = this.saved.y;
			return i + 2;
		}
		if (next !== "[") return i + 1; // unknown ESC — skip
		// CSI ... final byte
		let j = i + 2;
		let params = "";
		while (j < data.length && data[j] >= "0" && data[j] <= "9") params += data[j++];
		while (j < data.length && data[j] === ";") {
			params += ";";
			j++;
			while (j < data.length && data[j] >= "0" && data[j] <= "9") params += data[j++];
		}
		if (j >= data.length) return data.length;
		const cmd = data[j];
		const nums = params.split(";").map((n) => (n === "" ? 0 : Number(n)));
		const p1 = nums[0] || 1;
		const p2 = nums[1] || 1;
		switch (cmd) {
			case "A": this.y = Math.max(0, this.y - p1); break;
			case "B": this.y = Math.min(this.rows - 1, this.y + p1); break;
			case "C": this.x = Math.min(this.cols - 1, this.x + p1); break;
			case "D": this.x = Math.max(0, this.x - p1); break;
			case "H": case "f": this.y = Math.min(this.rows - 1, p1 - 1); this.x = Math.min(this.cols - 1, p2 - 1); break;
			case "J":
				if (nums[0] === 0) this.clear(this.y, this.rows - 1, this.x);
				else if (nums[0] === 1) this.clear(0, this.y, 0);
				else this.clear(0, this.rows - 1, 0);
				break;
			case "K":
				if (nums[0] === 0) this.clearRow(this.y, this.x, this.cols - 1);
				else if (nums[0] === 1) this.clearRow(this.y, 0, this.x);
				else this.clearRow(this.y, 0, this.cols - 1);
				break;
			case "L": { // insert lines at cursor row (within margins)
				const n = p1;
				for (let k = 0; k < n; k++) this.screen.splice(Math.min(this.y, this.bottom), 0, new Array(this.cols).fill(" "));
				this.screen.splice(this.bottom + 1);
				this.screen.length = this.rows;
				while (this.screen.length < this.rows) this.screen.push(new Array(this.cols).fill(" "));
				break;
			}
			case "M": { // delete lines at cursor row
				const n = p1;
				for (let k = 0; k < n; k++) this.screen.splice(Math.min(this.y, this.bottom), 1);
				while (this.screen.length < this.rows) this.screen.push(new Array(this.cols).fill(" "));
				break;
			}
			case "S": this.scrollUp(p1); break;
			case "T": this.scrollDown(p1); break;
			case "r": // DECSTBM: top;bottom (1-based), 0/absent = extremes
				this.top = nums[0] && nums[0] > 1 ? nums[0] - 1 : 0;
				this.bottom = nums[1] && nums[1] > 0 ? Math.min(this.rows - 1, nums[1] - 1) : this.rows - 1;
				break;
			default: break; // m (colors), others — ignored
		}
		return j + 1;
	}

	clear(fromRow, toRow, fromCol) {
		for (let r = fromRow; r <= toRow && r < this.rows; r++) {
			if (r === fromRow) this.clearRow(r, fromCol, this.cols - 1);
			else this.clearRow(r, 0, this.cols - 1);
		}
	}

	clearRow(row, from, to) {
		if (row < 0 || row >= this.rows) return;
		for (let c = from; c <= to && c < this.cols; c++) this.screen[row][c] = " ";
	}
}

module.exports = { VT };
