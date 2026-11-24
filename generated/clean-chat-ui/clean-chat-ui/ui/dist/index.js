// Hand-authored, self-contained ESM. No React or build dependencies.
const PLUGIN_ID = "clean-chat-ui";
const STYLE_ID = "octop-clean-chat-ui-style";
const classToken = (name) =>
  `:is([class^="index-module__${name}__"], [class*=" index-module__${name}__"])`;
const rows = `:is(${classToken("imagePreviewBar")}, ${classToken("userComposerTags")})`;
const hiddenChip = `:is(${classToken("contextChipConnector")}, ${classToken("contextChipKnowledge")}, ${classToken("contextChipModel")})`;
const sidePanel = ":is(aside[class^=\"SideChatPanel-module__panel__\"], aside[class*=\" SideChatPanel-module__panel__\"])";
const css = `
/* Hide chat token-usage indicators without changing collected usage data. */
${classToken("runUsageBar")},
${classToken("msgUsage")},
${classToken("contextRingBtn")} { display: none !important; }
/* Hide only the numeric badge on the composer + button. */
${classToken("toolbarBadge")} { display: none !important; }
/* Selection should not tint the + button; retain ordinary desktop hover and focus. */
button[data-testid="composer-plus"]${classToken("secondaryBtnActive")} {
  color: var(--fn-text-quaternary) !important;
  background: var(--fn-bg-secondary) !important;
  box-shadow: none !important;
}
@media (hover: hover) and (pointer: fine) {
  button[data-testid="composer-plus"]${classToken("secondaryBtnActive")}:hover {
    color: var(--fn-text-brand) !important;
    background: var(--fn-color-brand-bg) !important;
  }
}
/* Hide mobile hover hints, not Popover menus (which may also use role="tooltip"). */
@media (max-width: 767px), (hover: none) and (pointer: coarse) {
  .octop-tooltip { display: none !important; }
}
/* Hide MCP, knowledge-base and model chips in the composer and message history.
   The model selection inside the + menu stays untouched. */
${rows} > ${hiddenChip} { display: none !important; }
/* Remove only the side-chat composer new-conversation button. */
${sidePanel} button${classToken("newChatBtn")} { display: none !important; }
/* Collapse rows whose remaining direct children are all hidden targets. */
${rows}:not(:has(> :not(${hiddenChip}))) { display: none !important; }
`;

export function setup(host) {
  // The current loader also imports globally disabled plugins. Check the real
  // catalog before applying CSS, and replace stale styles on loader resets.
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  document.head.append(style);
  host.request("/plugins").then((plugins) => {
    if (!style.isConnected) return; // A newer setup owns the page now.
    const plugin = plugins.find((item) => item.id === PLUGIN_ID);
    if (plugin && plugin.enabled !== false && !plugin.error) {
      style.textContent = css;
    } else {
      style.remove();
    }
  }).catch((error) => {
    style.remove(); // Fail open: leave the native UI visible on auth/network errors.
    console.warn("[clean-chat-ui] Could not check plugin status; labels remain visible.", error);
  });
}
