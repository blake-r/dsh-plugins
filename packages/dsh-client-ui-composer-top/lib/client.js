window.__ModuleLoader__.load({
	id: "@blake-r/dsh-client-ui-composer-top",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// CSS injected once at materialization. Uses the same data-plugin-css
		// guard the official client bundles use so re-materialization (HMR /
		// reload) does not duplicate the <style> tag.
		//
		// All selectors are stable data-attribute hooks from the official
		// client bundles (dsh-client-ui-conversation / -chat / -user-questions
		// / -approval), so the plugin survives package updates without patches.
		const css = [
			// 1. Composer seat pinned to the top of the scroll area (active
			//    phase only; hero/settling untouched). order:-1 moves it before
			//    the message column, sticky top:0 pins it under the header.
			//    The backdrop is fully opaque bg-base: the stock 36px gradient
			//    (meant for the bottom-anchored seat) leaves the rest of the
			//    seat transparent, so with a wider message column (wider-chat)
			//    message text shows through beside/under the composer card.
			"[data-phase=active] [data-composer-seat]{order:-1;position:sticky;top:0;bottom:auto!important;padding-top:8px;background:var(--dsw-alias-bg-base)!important}",
			// 2. Dock panels (request queue, todo) below the input: flip the
			//    composer stack. The queue dock's existing negative bottom
			//    margin mirrors to a 3px overlap under the input, same as
			//    before.
			"[data-phase=active] [data-composer-seat] > :has([data-queue-dock],[data-todo-dock]){flex-direction:column-reverse}",
			// 3. Scroll-to-bottom button: the --dsh-composer-height offset was
			//    meant for the bottom composer; zero it on the message column
			//    so the button sits at the bottom edge of the visible area. The
			//    turn rail (sibling of the column) keeps the real height and
			//    stays centered in the visible message area.
			"[data-chat-flow]{--dsh-composer-height:0px!important}",
			// 4. Defensive clamps: user-dialog cards must never exceed the
			//    visible area (header + margins). Existing clamps (60vh / 336px)
			//    already fit; these add a hard viewport bound for short windows.
			"[data-question-key] > *{max-height:min(60vh,520px,calc(100dvh - 140px))!important}",
			"[data-approval-scroll]{max-height:min(var(--dsh-composer-text-max-height),calc(100dvh - 140px))!important}",
			// 5. Trajectory overlay: the stock overlay layout floats the
			//    composer seat (position:absolute) over the trajectory view.
			//    With the seat pinned at the top that hides the trajectory
			//    toolbar and the first rows under the composer card. Keep the
			//    seat in-flow (sticky, order:-1) so the trajectory starts
			//    below it, and drop the stock bottom clearance (it was meant
			//    for the bottom-anchored composer). The trajectory ledger
			//    derives its bottom clearance from --dsh-composer-height
			//    (set inline on the scroll body by the seat ResizeObserver);
			//    zero it so the table and details panel don't keep a dead
			//    strip at the bottom.
			"[data-conversation-scroll]:has([data-conversation-composer-overlay]) > [data-composer-seat]{position:sticky!important;top:0!important;bottom:auto!important}",
			"[data-conversation-scroll]:has([data-conversation-composer-overlay]){--dsh-composer-height:0px!important}",
			"[data-conversation-scroll]:has([data-conversation-composer-overlay]) [data-trajectory-scroll]{padding-bottom:0!important}",
			// 6. Command/skill dropdowns (slash menu + popupSelect) open
			//    downward: the stock menus are bottom-anchored
			//    (bottom:calc(100% + 4px)) and grow upward — with the seat
			//    pinned at the top they slide under the Chat/Trajectory header
			//    and get clipped by the scroll container. Move the overlay
			//    anchor to the card's bottom edge (100% of the zero-height
			//    anchor then means "below the card") and re-anchor the menus
			//    below the card. The popupSelect card is the overlay's only
			//    aria-labelled child (the slash menu carries data-trigger-menu,
			//    the feedback entry renders a hidden probe).
			"[data-phase=active] [data-composer-card] > :has(> [data-slot=\"conversation.input.overlay\"]){inset:auto 0 0 0!important}",
			"[data-phase=active] [data-composer-card] [data-trigger-menu]{bottom:auto!important;top:calc(100% + 4px)!important}",
			"[data-phase=active] [data-composer-card] [data-slot=\"conversation.input.overlay\"] > [aria-label]{bottom:auto!important;top:calc(100% + 4px)!important}"
		].join("");

		const tagId = "@blake-r/dsh-client-ui-composer-top/composer-top.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@blake-r/dsh-client-ui-composer-top";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** No client-side behavior beyond the injected stylesheet. */
		function apply() {}

		const inject = [];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});