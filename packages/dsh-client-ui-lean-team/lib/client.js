window.__ModuleLoader__.load({
	id: "@blake-r/dsh-client-ui-lean-team",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// CSS for the entry pill and the modal, injected once at materialization.
		// Uses the same data-plugin-css guard the official client bundles use so
		// re-materialization (HMR / reload) does not duplicate the <style> tag.
		// The entry is a labeled pill in the header's utilities row (the amended
		// design, task-201): the kanban/board glyph (16px) plus the visible text
		// "Lean Team", the pill's height matching the header's 28px utility
		// squares, the label-secondary color, the hover background, the same
		// padding rhythm as the neighboring header controls (the sessions-
		// switcher's trigger). The modal is a fixed overlay above the GUI's
		// chrome with the kanban UI in a same-origin iframe.
		const css = [
			".lt-entry{display:inline-flex;align-items:center;gap:6px;flex:none;height:28px;padding:0 10px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:8px;cursor:pointer;font-size:13px;line-height:20px;white-space:nowrap}",
			".lt-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".lt-entry:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}",
			".lt-entry-label{white-space:nowrap}",
			".lt-modal{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,#1e1e1e)}",
			".lt-modal-bar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;height:44px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#c0c4cc)}",
			".lt-modal-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".lt-modal-close{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:8px;cursor:pointer}",
			".lt-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".lt-modal-close:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}",
			".lt-modal-frame{flex:1;width:100%;border:none;background:transparent}"
		].join("");
		const tagId = "@blake-r/dsh-client-ui-lean-team/lean-team.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@blake-r/dsh-client-ui-lean-team";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// The modal: created imperatively on open (so each open reloads the board
		// from the live data), removed on close. The close affordances are the X
		// button in the bar's corner and the Escape key. No window.open, no
		// navigation — the address bar stays unchanged (works in Chrome and the
		// tauri webview alike).
		let modal = null;
		let onKeyDown = null;

		function closeModal() {
			if (modal === null) return;
			if (onKeyDown !== null) {
				document.removeEventListener("keydown", onKeyDown);
				onKeyDown = null;
			}
			modal.remove();
			modal = null;
		}

		function openModal() {
			if (modal !== null) return;
			modal = document.createElement("div");
			modal.className = "lt-modal";
			modal.setAttribute("role", "dialog");
			modal.setAttribute("aria-modal", "true");
			modal.setAttribute("aria-label", "Lean Team kanban board");
			const bar = document.createElement("div");
			bar.className = "lt-modal-bar";
			const title = document.createElement("span");
			title.className = "lt-modal-title";
			title.textContent = "Lean Team kanban";
			const close = document.createElement("button");
			close.className = "lt-modal-close";
			close.type = "button";
			close.title = "Close (Esc)";
			close.setAttribute("aria-label", "Close the Lean Team kanban board");
			close.addEventListener("click", closeModal);
			// The close glyph as a real DOM node: react.createElement returns a
			// React element (a plain object), never a DOM node — appending it
			// throws "parameter 1 is not of type 'Node'" and the modal never
			// reaches document.body (the click-does-nothing defect, task-202).
			const closeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			closeSvg.setAttribute("width", "16");
			closeSvg.setAttribute("height", "16");
			closeSvg.setAttribute("viewBox", "0 0 16 16");
			closeSvg.setAttribute("fill", "none");
			closeSvg.setAttribute("aria-hidden", "true");
			const closePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
			closePath.setAttribute("d", "M4 4l8 8M12 4l-8 8");
			closePath.setAttribute("stroke", "currentColor");
			closePath.setAttribute("stroke-width", "1.5");
			closePath.setAttribute("stroke-linecap", "round");
			closeSvg.appendChild(closePath);
			close.appendChild(closeSvg);
			bar.appendChild(title);
			bar.appendChild(close);
			const frame = document.createElement("iframe");
			frame.className = "lt-modal-frame";
			frame.src = "/lean-team/";
			frame.title = "Lean Team kanban board";
			modal.appendChild(bar);
			modal.appendChild(frame);
			onKeyDown = (event) => {
				if (event.key === "Escape") closeModal();
			};
			document.addEventListener("keydown", onKeyDown);
			document.body.appendChild(modal);
			close.focus();
		}

		const inject = ["slots"];

		function apply(ctx) {
			const slots = ctx.slots;
			const renderLeanTeamEntry = () => react.createElement(
				"button",
				{
					className: "lt-entry",
					type: "button",
					title: "Lean Team",
					"aria-label": "Open the Lean Team kanban board",
					onClick: openModal,
				},
				react.createElement(primitives.IconPanelLeftOutlineMedium, { size: 16 }),
				react.createElement("span", { className: "lt-entry-label" }, "Lean Team")
			);
			slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "lean-team-entry", order: -15 },
				renderLeanTeamEntry
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});