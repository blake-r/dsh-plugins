window.__ModuleLoader__.load({
	id: "@blake-r/dsh-client-ui-composer-reverse",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// CSS injected once at materialization. Uses the same data-plugin-css
		// guard the official client bundles use so re-materialization (HMR /
		// reload) does not duplicate the <style> tag.
		//
		// All rules are gated on body.dsh-composer-reverse-stuck, a class the
		// client script below toggles only while the composer seat is pinned
		// at the top of the viewport (the composer-top layout). Without that
		// layout the plugin stays inert.
		//
		// Selectors use stable data attributes from the official client
		// bundles (data-composer-seat, data-composer-card, data-composer-stats,
		// data-session-stats-details/-usage, data-slot) plus ARIA roles; no
		// patches to system packages are needed.
		const css = [
			// 1. Full stack reversal: the composer stack flips so the dock row
			//    (recent sessions, request queue, todo) sits below the input
			//    bar, and the input bar flips so the stats dock sits above the
			//    card. Everything that was at the bottom of the composer moves
			//    to the top ("reverse the content completely").
			"body.dsh-composer-reverse-stuck [data-composer-seat] :has(> [data-slot=\"conversation.composer.bar\"]){flex-direction:column-reverse}",
			"body.dsh-composer-reverse-stuck [data-composer-seat] :has(> [data-composer-card]){flex-direction:column-reverse}",
			// 2. Inline popovers (access-mode menu, context-meter panel) open
			//    downward instead of upward: with the seat pinned at the top
			//    the upward-opening menus slide under the Chat/Trajectory
			//    header and get clipped by the scroll container. Re-anchor
			//    them below their trigger (100% of the trigger height).
			"body.dsh-composer-reverse-stuck [data-composer-card] [role=\"menu\"]{top:calc(100% + 4px)!important;bottom:auto!important}",
			"body.dsh-composer-reverse-stuck [data-composer-card] [role=\"dialog\"]{top:calc(100% + 8px)!important;bottom:auto!important}",
			// 3. Portaled popovers (stats dialogs, model menu) are positioned
			//    by JS with side:"top" and clamped to the viewport top edge
			//    (12px margin) — with the seat at the top they cover the
			//    header. The client script tracks the anchor's bottom edge
			//    into a CSS variable; the transform shifts the popover from
			//    its JS position to just below the anchor (8px gap). The
			//    min() picks the right shift for both cases: clamped to the
			//    top edge (anchorBottom - 4) and unclamped above the trigger
			//    (100% + triggerHeight + 2*gap).
			"body.dsh-composer-reverse-stuck > [role=\"dialog\"]:has([data-session-stats-details],[data-session-stats-usage]){transform:translateY(min(var(--dsh-composer-reverse-stats-offset,0px), calc(100% + 42px)))!important}",
			"body.dsh-composer-reverse-stuck > [role=\"menu\"][aria-label=\"Model and reasoning effort\"]{transform:translateY(min(var(--dsh-composer-reverse-model-offset,0px), calc(100% + 44px)))!important}"
		].join("");

		const tagId = "@blake-r/dsh-client-ui-composer-reverse/composer-reverse.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@blake-r/dsh-client-ui-composer-reverse";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/**
		 * Client-side behavior: toggle the "stuck" gate class while the
		 * composer seat is pinned at the top, and track the popover anchors'
		 * bottom edges into CSS variables used by rule 3.
		 *
		 * The portaled popovers are clamped to the top edge by their own
		 * positioning hook (margin 12px, gap 8px), so shifting them by
		 * (anchorBottom - 12 + 8) puts their top edge at anchorBottom + 8.
		 */
		function apply() {
			if (typeof document === "undefined") return;
			let raf = 0;
			const track = () => {
				const seat = document.querySelector("[data-composer-seat]");
				if (!seat) return;
				const stuck = seat.getBoundingClientRect().top <= 150;
				document.body.classList.toggle("dsh-composer-reverse-stuck", stuck);
				if (!stuck) return;
				const stats = document.querySelector("[data-composer-stats]");
				if (stats) {
					const bottom = stats.getBoundingClientRect().bottom;
					document.body.style.setProperty("--dsh-composer-reverse-stats-offset", Math.round(bottom - 4) + "px");
				}
				const model = document.querySelector('[data-slot="conversation.input.model"] button');
				if (model) {
					const bottom = model.getBoundingClientRect().bottom;
					document.body.style.setProperty("--dsh-composer-reverse-model-offset", Math.round(bottom - 4) + "px");
				}
			};
			const schedule = () => {
				if (raf) return;
				raf = requestAnimationFrame(() => {
					raf = 0;
					track();
				});
			};
			track();
			if (typeof MutationObserver !== "undefined") {
				new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
			}
			window.addEventListener("scroll", schedule, true);
			window.addEventListener("resize", schedule);
		}

		const inject = [];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});