// modules/dnd5e-custom-resources/scripts/main.js
(() => {
  "use strict";

  const MODULE_ID = "dnd5e-custom-resources";
  const FLAG_PATH = `flags.${MODULE_ID}.resources`;
  const ROOT_SEL  = `[data-${MODULE_ID}-root]`;
  const ADD_BTN_ATTR = `data-${MODULE_ID}-addbtn`;
  const EVT_NS = `.cr_${MODULE_ID}`;

  window.__CR_LOADED = true;
  console.log(`${MODULE_ID} | main.js loaded`);

  Hooks.on("renderActorSheet", (app, html) => scheduleMount(app, html));
  Hooks.on("renderActorSheet5eCharacter2", (app, html) => scheduleMount(app, html));
  Hooks.on("renderActorSheetV2", (app, html) => scheduleMount(app, html));
  Hooks.on("updateActor", (actor, diff, opts, userId) => {
    // Re-mount on actor updates because other modules may rerender sidebar meters without firing render hooks.
    try {
      for (const app of Object.values(actor.apps ?? {})) {
        if (!app?.rendered) continue;
        const el = app.element;
        if (!el) continue;
        scheduleMount(app, el);
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | updateActor remount failed`, e);
    }
  });
function scheduleMount(app, html) {
  const actor = app?.actor;
  if (!actor) return;

  // ONLY player characters:
  // - type must be "character"
  // - must have at least one PLAYER owner (so GM-only chars / NPC / monsters won't get the UI)
  if (actor.type !== "character") return;
  if (!actor.hasPlayerOwner) return;

  const $html = toJQ(html);
  if (!$html) return;

  requestAnimationFrame(() => mount(app, $html));
}

 function mount(app, $html) {
  const actor = app.actor;

  // Tidy-only CSS fix (does NOT affect the default sheet)
  ensureTidyFillFix($html);

  // --- Ensure root exists and is placed correctly for each sheet type ---
  let $root = $html.find(ROOT_SEL);

  if (!$root.length) {
    // Tidy 5e: place our block ABOVE the favorites drop/list (above empty-state)
    const $tidyFav = $html
      .find(`.tidy-tab.favorites[data-tidy-sheet-part="tab-content"], .tidy-tab.favorites`)
      .first();

    if ($tidyFav.length) {
      const root = $(`<div data-${MODULE_ID}-root></div>`);

      const $favList = $tidyFav.find(".favorites.list").first();
      if ($favList.length) $favList.before(root);
      else {
        const $empty = $tidyFav.find(".empty-state-container").first();
        if ($empty.length) $empty.before(root);
        else $tidyFav.prepend(root);
      }

      $root = root;
    } else {
      // Default sheet: old behavior
      const anchor = findAnchor($html);
      if (!anchor?.length) return;
      const root = $(`<div data-${MODULE_ID}-root></div>`);
      anchor.after(root);
      $root = root;
    }
  }

  renderResources(actor, $html);
  bindHandlers(actor, $html);
  ensurePlusNearSkull($html);
}

  function findAnchor($html) {
  // --- Tidy 5e Sheet: Favorites tab (place bars BEFORE the favorites drop/list) ---
  const $tidyFav = $html
    .find(`.tidy-tab.favorites[data-tidy-sheet-part="tab-content"], .tidy-tab.favorites`)
    .first();

  if ($tidyFav.length) {
    const $spContainer = $tidyFav.find(".sp-bar-container").first();
    if ($spContainer.length) return $spContainer;

    // Fallback: if layout differs, still try to anchor before the favorites list
    const $favList = $tidyFav.find(".favorites.list").first();
    if ($favList.length) return $favList;
    return $tidyFav;
  }

  // --- Default dnd5e sheet (existing behavior) ---
  // Prefer stable sidebar stats container (language-agnostic).
  const stats = $html.find(".sidebar .stats").first();
  if (stats.length) {
    const lastGroup = stats.find("> .meter-group").last();
    if (lastGroup.length) return lastGroup;
    return stats;
  }

  // Fallbacks (older layouts / other sheets)
  const sidebar = $html.find(".sidebar").first();
  if (sidebar.length) return sidebar;
  return null;
}

  // -------------------- Data --------------------

  function getResources(actor) {
    return foundry.utils.getProperty(actor, FLAG_PATH) ?? [];
  }

  async function saveResources(actor, resources) {
    await actor.update({ [FLAG_PATH]: resources });
  }

  function normalizeStored(r) {
    r.value = Number(r.value) || 0;
    r.max = Number(r.max) || 0;
    return r;
  }

  async function readResource(actor, r) {
    if (r?.mode === "stored") {
      r = normalizeStored(r);
      return { value: r.value, max: r.max };
    }

    if (r?.mode === "item" && r.itemUuid) {
      const item = await fromUuid(r.itemUuid);
      if (!item) return { value: 0, max: 0 };

      const max = Number(foundry.utils.getProperty(item, r.itemPaths?.max ?? "system.uses.max")) || 0;

      if (r.itemPaths?.spent) {
        const spent = Number(foundry.utils.getProperty(item, r.itemPaths.spent)) || 0;
        return { value: Math.max(0, max - spent), max };
      }

      const value = Number(foundry.utils.getProperty(item, r.itemPaths?.value ?? "system.uses.value")) || 0;
      return { value, max };
    }

    return { value: 0, max: 0 };
  }

  async function writeValue(actor, r, newValue) {
    const v = Number(newValue) || 0;

    if (r?.mode === "stored") {
      const resources = getResources(actor);
      const idx = resources.findIndex(x => x.id === r.id);
      if (idx === -1) return;
      resources[idx].value = v;
      await saveResources(actor, resources);
      return;
    }

    if (r?.mode === "item" && r.itemUuid) {
      const item = await fromUuid(r.itemUuid);
      if (!item) return;

      if (r.itemPaths?.spent) {
        const max = Number(foundry.utils.getProperty(item, r.itemPaths.max ?? "system.uses.max")) || 0;
        const spent = Math.max(0, max - v);
        await item.update({ [r.itemPaths.spent]: spent });
        return;
      }

      await item.update({ [r.itemPaths?.value ?? "system.uses.value"]: v });
    }
  }

  async function writeMax(actor, r, newMax) {
    const m = Number(newMax) || 0;

    if (r?.mode === "stored") {
      const resources = getResources(actor);
      const idx = resources.findIndex(x => x.id === r.id);
      if (idx === -1) return;
      resources[idx].max = m;
      await saveResources(actor, resources);
      return;
    }

    if (r?.mode === "item" && r.itemUuid) {
      const item = await fromUuid(r.itemUuid);
      if (!item) return;
      await item.update({ [r.itemPaths?.max ?? "system.uses.max"]: m });
    }
  }

  // -------------------- Render (native meter markup) --------------------

async function renderResources(actor, $html) {
  const $root = $html.find(ROOT_SEL);
  if (!$root.length) return;

  const resources = getResources(actor);
  const editable = isSheetEditable($html);

  // HARD TIDY DETECT (based on actual tidy DOM around our root)
  const isTidy =
    $root.closest(".tidy-tab, [data-tidy-sheet-part]").length > 0 ||
    $html.closest(".tidy-tab, [data-tidy-sheet-part]").length > 0 ||
    $html.find(".tidy-tab, [data-tidy-sheet-part]").length > 0;

  // Only for Tidy: force the progress box to have NO padding/border that would shrink the fill.
  // (This is what makes the fill look thinner in Tidy.)
  const tidyProgressStyle = isTidy
    ? [
        "padding:0 !important;",
        "margin:0 !important;",
        "border:0 !important;",
        "outline:0 !important;",
        "box-sizing:border-box !important;",
        "overflow:hidden !important;",
        "position:relative !important;",
        "width:100% !important;",
        "inline-size:100% !important;",
        "min-height:100% !important;",
      ].join("")
    : "";

  // Only for Tidy: full-bleed fill (no inset)
  const tidyFillStyle = isTidy
    ? [
        "inset:0 !important;",
        "left:0 !important;",
        "right:0 !important;",
        "top:0 !important;",
        "bottom:0 !important;",
        "width:100% !important;",
        "height:100% !important;",
        "box-sizing:border-box !important;",
        "border-radius:3px !important;",
      ].join("")
    : "";

  $root.empty();

  // no resources -> dropzone only in Edit
  if (!resources.length) {
    if (!editable) return;

    $root.append($(`
      <div class="dnd5e-custom-resources__dropzone">
        <div class="dnd5e-custom-resources__dropzone-title">
          Перетащи предмет/способность, чтобы создать ресурс
        </div>
      </div>
    `));
    return;
  }

  for (const r of resources) {
    const { value, max } = await readResource(actor, r);

    const v = Number(value) || 0;
    const m = Number(max) || 0;
    const scale = m > 0 ? Math.min(1, Math.max(0, v / m)) : 0;

    const left = (r.colors?.left ?? "#3a0e5f").toString();
    const right = (r.colors?.right ?? "#8a40c7").toString();

    $root.append($(`
      <div class="meter-group dnd5e-custom-resources__wrap" data-res-id="${r.id}">
        <div class="label roboto-condensed-upper">
          <span>${escapeHtml(r.label ?? "CUSTOM")}</span>
          ${editable ? `
            <a class="config-button dnd5e-custom-resources__config"
               data-res-id="${r.id}"
               data-tooltip="Настроить ресурс"
               aria-label="Настроить ресурс">
              <i class="fas fa-cog"></i>
            </a>
          ` : ``}
        </div>

        <div class="meter sectioned dnd5e-custom-resources__meter">
          <div class="progress dnd5e-custom-resources__progress"
               role="meter"
               aria-valuemin="0" aria-valuenow="${v}" aria-valuemax="${m}"
               style="
                 --cr-bar-scale:${scale};
                 --cr-left-color:${left};
                 --cr-right-color:${right};
                 ${tidyProgressStyle}
               ">
            <div class="dnd5e-custom-resources__fill" aria-hidden="true" style="${tidyFillStyle}"></div>

            <div class="label dnd5e-custom-resources__value-label">
              <span class="value">${v}</span>
              <span class="separator"> / </span>
              <span class="max">${m}</span>
            </div>

            <input hidden
                   type="text"
                   data-dtype="Number"
                   class="cr_value seamless-input"
                   value="${v}">
          </div>
        </div>
      </div>
    `));
  }

  // dropzone only in Edit
  if (editable) {
    $root.append($(`
      <div class="dnd5e-custom-resources__dropzone">
        <div class="dnd5e-custom-resources__dropzone-title">
          Перетащи предмет/способность, чтобы создать ресурс
        </div>
      </div>
    `));
  }
}
function ensureTidyFillFix($html) {
  const STYLE_ID = "dnd5e-custom-resources__tidy-fill-fix";

  // already injected
  if (document.getElementById(STYLE_ID)) return;

  // detect Tidy (safe & scoped)
  const isTidy =
    $html.closest(".app").hasClass("tidy5e-sheet") ||
    $html.closest(".app").hasClass("tidy-sheet") ||
    $html.find(".tidy5e-sheet, .tidy-tab, [data-tidy-sheet-part]").length > 0 ||
    $html.closest(".tidy5e-sheet, .tidy-tab, [data-tidy-sheet-part]").length > 0;

  if (!isTidy) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Tidy 5e ONLY: make our animated fill flush with the bar */
    .tidy5e-sheet .meter-group.dnd5e-custom-resources__wrap .dnd5e-custom-resources__fill,
    .tidy-tab .meter-group.dnd5e-custom-resources__wrap .dnd5e-custom-resources__fill,
    [data-tidy-sheet-part] .meter-group.dnd5e-custom-resources__wrap .dnd5e-custom-resources__fill {
      inset: 0 !important;
      border-radius: 3px !important; /* inner radius for 4px outer shell */
    }
  `;
  document.head.appendChild(style);
}
  // -------------------- Events (no duplicates) --------------------

 function bindHandlers(actor, $html) {
  const $root = $html.find(ROOT_SEL);
  if (!$root.length) return;

  $root.off(EVT_NS);
  $html.off(EVT_NS);

  // Шестерёнка -> меню настроек (ТОЛЬКО в Edit)
  $root.on(`click${EVT_NS}`, `.dnd5e-custom-resources__config`, async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    if (!isSheetEditable($html)) return;

    const id = $(ev.currentTarget).attr("data-res-id");
    const r = getResources(actor).find(x => x.id === id);
    if (!r) return;

    const cur = await readResource(actor, r);

    const out = await promptEditDeleteColors(
      r.label ?? "CUSTOM",
      cur.value,
      cur.max,
      r.colors?.left ?? "#3a0e5f",
      r.colors?.right ?? "#8a40c7"
    );
    if (!out) return;

    if (out.delete) {
      const next = getResources(actor).filter(x => x.id !== id);
      await saveResources(actor, next);
      await renderResources(actor, $html);
      return;
    }

    // update colors
    {
      const resources = getResources(actor);
      const idx = resources.findIndex(x => x.id === id);
      if (idx !== -1) {
        resources[idx].colors = { left: out.left, right: out.right };
        await saveResources(actor, resources);
      }
    }

    // update max/value
    await writeMax(actor, r, out.max);
    await writeValue(actor, r, out.value);
    await renderResources(actor, $html);
  });

  // Клик по цифрам в баре -> inline edit value (как spellpoints)
  $root.on(`click${EVT_NS}`, `.dnd5e-custom-resources__progress .dnd5e-custom-resources__value-label`, (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    const $progress = $(ev.currentTarget).closest(".dnd5e-custom-resources__progress");
    $progress.find(".dnd5e-custom-resources__value-label").attr("hidden", "hidden");

    const $input = $progress.find("input.cr_value");
    $input.removeAttr("hidden");
    $input.trigger("focus");
    $input.trigger("select");
  });

  // blur/enter -> сохранить value, вернуть label
  $root
    .on(`blur${EVT_NS}`, `.dnd5e-custom-resources__progress input.cr_value`, async (ev) => {
      const $input = $(ev.currentTarget);
      const $wrap = $input.closest(".dnd5e-custom-resources__wrap");
      const id = $wrap.attr("data-res-id");

      const r = getResources(actor).find(x => x.id === id);
      if (!r) return;

      const cur = await readResource(actor, r);
      const max = Number(cur.max) || 0;

      let v = Number($input.val());
      if (!Number.isFinite(v)) v = 0;
      v = Math.trunc(v);

      if (max > 0) v = Math.max(0, Math.min(max, v));
      else v = Math.max(0, v);

      await writeValue(actor, r, v);

      // вернуть UI
      $input.attr("hidden", "hidden");
      $input.closest(".dnd5e-custom-resources__progress")
        .find(".dnd5e-custom-resources__value-label")
        .removeAttr("hidden");

      await renderResources(actor, $html);
    })
    .on(`keydown${EVT_NS}`, `.dnd5e-custom-resources__progress input.cr_value`, (ev) => {
      if (ev.key === "Enter") ev.currentTarget.blur();
    });

  // Plus -> только ручное создание (как было)
  $html.on(`click${EVT_NS}`, `[${ADD_BTN_ATTR}]`, async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    await openAddDialog(actor, $html);
  });

  // Drop capture (как у тебя уже работает)
  installDropCapture(actor, $html);
}
async function openAddDialog(actor, $html) {
  await createStoredResourceWithColors(actor, $html);
}
function installDropCapture(actor, $html) {
  // ставим один раз на конкретный html-экземпляр листа
  if ($html.data("crDropCaptureInstalled")) return;
  $html.data("crDropCaptureInstalled", true);

  const el = $html[0];
  if (!el) return;

  const onDragOver = (e) => {
    if (!isSheetEditable($html)) return;
    // разрешаем drop только если курсор над нашим блоком
    const root = el.querySelector(ROOT_SEL);
    if (!root) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(ROOT_SEL)) return;
    e.preventDefault();
  };

  const onDrop = async (e) => {
    if (!isSheetEditable($html)) return;

    const root = el.querySelector(ROOT_SEL);
    if (!root) return;

    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(ROOT_SEL)) return;

    e.preventDefault();
    e.stopPropagation();

    // handleDrop ждёт объект с preventDefault + originalEvent
    await handleDrop({ preventDefault: () => e.preventDefault(), originalEvent: e }, actor, $html);
  };

  // CAPTURE = true (важно, чтобы пробить перехват dnd5e/других модулей)
  el.addEventListener("dragover", onDragOver, true);
  el.addEventListener("drop", onDrop, true);
}

function isSheetEditable($html) {
  // detect Tidy context
  const $app = $html.closest(".app");
  const isTidy =
    $html.find(".tidy5e-sheet, .tidy-tab, [data-tidy-sheet-part]").length > 0 ||
    ($app.length && ($app.hasClass("tidy5e-sheet") || $app.hasClass("tidy-sheet")));

  // 1) Core dnd5e / many sheets: edit-mode => <form class="editable">
  const $form = $html.is("form") ? $html : $html.find("form").first();
  if ($form.length && $form.hasClass("editable")) return true;

  // 2) Tidy 5e: lock switch (YOUR mapping)
  if (isTidy) {
    const $lockSwitch = $html
      .find('[role="switch"][aria-checked]')
      .filter((_, el) => {
        const $el = $(el);
        return $el.find("i.thumb-icon, i.fas, i.fa").filter((__, i) => {
          const c = i.className || "";
          return /fa-lock|fa-unlock|fa-lock-open/.test(c);
        }).length > 0;
      })
      .first();

    if ($lockSwitch.length) {
      const checked = String($lockSwitch.attr("aria-checked") ?? "").toLowerCase();

      // icon override (most reliable)
      const $i = $lockSwitch.find("i").first();
      if ($i.length) {
        if ($i.hasClass("fa-lock-open") || $i.hasClass("fa-unlock")) return true;
        if ($i.hasClass("fa-lock") || $i.hasClass("fa-lock-keyhole")) return false;
      }

      // YOUR mapping
      if (checked === "true") return true;
      if (checked === "false") return false;
    }
  }

  // 3) Other common toggles
  const $toggle = $html
    .find(
      [
        '[data-action="toggleEdit"]',
        '[data-action="toggleEditMode"]',
        '[data-action="toggleEditSheet"]',
        'button[name="toggleEdit"]',
        '[data-action="edit"]',
        ".toggle-edit",
        ".edit-toggle",
        ".lock-toggle",
        ".sheet-lock",
      ].join(",")
    )
    .filter(":visible")
    .first();

  if ($toggle.length) {
    const pressed = String($toggle.attr("aria-pressed") ?? "").toLowerCase();
    if (pressed === "true") return true;
    if (pressed === "false") return false;

    // IMPORTANT:
    // This inverted mapping you used is correct for your Tidy case,
    // but can be wrong for default sheets. So apply it ONLY on Tidy.
    if (isTidy) {
      if ($toggle.hasClass("active") || $toggle.hasClass("on") || $toggle.hasClass("enabled")) return false;
      if ($toggle.hasClass("inactive") || $toggle.hasClass("off") || $toggle.hasClass("disabled")) return true;

      const $i = $toggle.find("i").first();
      if ($i.length) {
        if ($i.hasClass("fa-lock-open") || $i.hasClass("fa-unlock")) return false;
        if ($i.hasClass("fa-lock") || $i.hasClass("fa-lock-keyhole")) return true;
      }
    } else {
      // Standard behavior for non-tidy toggles
      if ($toggle.hasClass("active") || $toggle.hasClass("on") || $toggle.hasClass("enabled")) return true;
      if ($toggle.hasClass("inactive") || $toggle.hasClass("off") || $toggle.hasClass("disabled")) return false;

      const $i = $toggle.find("i").first();
      if ($i.length) {
        if ($i.hasClass("fa-lock-open") || $i.hasClass("fa-unlock")) return true;
        if ($i.hasClass("fa-lock") || $i.hasClass("fa-lock-keyhole")) return false;
      }
    }
  }

  // 4) Last-resort heuristic ONLY for Tidy (default sheet has enabled inputs even in view mode)
  if (isTidy) {
    const $enabled = $html
      .find('input:not([type="hidden"]):enabled, select:enabled, textarea:enabled')
      .filter((_, el) => !$(el).closest(ROOT_SEL).length);

    if ($enabled.length) return true;
  }

  // Default: NOT editable
  return false;
}
 async function handleDrop(ev, actor, $html) {
  ev.preventDefault();

  let data;
  try {
    const TE = foundry.applications.ux.TextEditor.implementation;
    data = TE.getDragEventData(ev.originalEvent ?? ev);
  } catch {
    return;
  }

  if (!data || data.type !== "Item" || !data.uuid) return;

  const item = await fromUuid(data.uuid);
  if (!item) return;

  const usesMax   = foundry.utils.getProperty(item, "system.uses.max");
  const usesVal   = foundry.utils.getProperty(item, "system.uses.value");
  const usesSpent = foundry.utils.getProperty(item, "system.uses.spent");

  const hasNormal = usesMax != null && usesVal != null;
  const hasSpent  = usesMax != null && usesSpent != null;

  if (!hasNormal && !hasSpent) {
    ui.notifications.warn("Item has no Uses.");
    return;
  }

  const resources = getResources(actor);
  resources.push({
    id: foundry.utils.randomID(),
    label: item.name,
    mode: "item",
    itemUuid: item.uuid,
    itemPaths: hasSpent
      ? { max: "system.uses.max", spent: "system.uses.spent" }
      : { max: "system.uses.max", value: "system.uses.value" },
    colors: { left: "#3a0e5f", right: "#8a40c7" } // default gradient for dropped
  });

  await saveResources(actor, resources);
  await renderResources(actor, $html);
}
async function createStoredResourceWithColors(actor, $html) {
  const out = await promptResourceConfigDialog({
    mode: "create",
    label: "CUSTOM",
    value: 0,
    max: 0,
    left: "#3a0e5f",
    right: "#8a40c7"
  });

  if (!out) return;

  const resources = getResources(actor);
  resources.push({
    id: foundry.utils.randomID(),
    label: (out.label || "CUSTOM").trim(),
    mode: "stored",
    max: Number(out.max) || 0,
    value: Number(out.value) || 0,
    colors: { left: out.left, right: out.right }
  });

  await saveResources(actor, resources);
  await renderResources(actor, $html);
}
function promptResourceConfigDialog({ mode, label, value, max, left, right }) {
  const isCreate = mode === "create";
  const titleText = isCreate ? "Create Resource" : `Configure: ${label ?? "CUSTOM"}`;

  const safeLabel = escapeHtml(label ?? "CUSTOM");
  const v0 = Number(value) || 0;
  const m0 = Number(max) || 0;

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };

    const content = `
      <div class="cr-mini">
        <div class="cr-mini-top">
          <div class="cr-mini-icon" aria-hidden="true"><i class="fas fa-gem"></i></div>

          ${isCreate ? `
            <div class="cr-mini-name">
              <div class="cr-mini-cap">NAME</div>
              <input class="cr-mini-text" type="text" name="cr_label" value="${safeLabel}">
            </div>
          ` : ``}

          <div class="cr-mini-num">
            <div class="cr-mini-cap">CURRENT</div>
            <input class="cr-mini-big" type="number" name="cr_value" value="${v0}">
          </div>

          <div class="cr-mini-num">
            <div class="cr-mini-cap">MAX</div>
            <input class="cr-mini-big" type="number" name="cr_max" value="${m0}">
          </div>
        </div>

        <div class="cr-mini-colors">
          <div class="cr-mini-cap">COLORS</div>
          <div class="cr-mini-colorrow">
            <label class="cr-mini-color">
              <span>LEFT</span>
              <input type="color" name="cr_left" value="${escapeHtml(left ?? "#3a0e5f")}">
            </label>
            <label class="cr-mini-color">
              <span>RIGHT</span>
              <input type="color" name="cr_right" value="${escapeHtml(right ?? "#8a40c7")}">
            </label>
          </div>
        </div>

        <div class="cr-mini-footer">
          <div class="left">
            ${!isCreate ? `
              <button type="button" class="unbutton control-button" data-action="cr_delete">
                <i class="fas fa-trash" inert></i>
              </button>
            ` : ``}
          </div>
          <div class="right">
            <button type="button" class="unbutton control-button" data-action="cr_cancel">Cancel</button>
            <button type="button" class="unbutton control-button cr-primary" data-action="cr_save">Save</button>
          </div>
        </div>
      </div>
    `;

    const dlg = new Dialog(
      {
        title: titleText,
        content,
        buttons: {},
        render: (html) => {
          const $c = html.find(".cr-mini");

          const $focus = isCreate ? $c.find('input[name="cr_label"]') : $c.find('input[name="cr_value"]');
          setTimeout(() => { $focus.trigger("focus"); $focus.trigger("select"); }, 0);

          $c.on("click", '[data-action="cr_cancel"]', (e) => {
            e.preventDefault();
            finish(null);
            dlg.close();
          });

          $c.on("click", '[data-action="cr_delete"]', (e) => {
            e.preventDefault();
            finish({ delete: true });
            dlg.close();
          });

          $c.on("click", '[data-action="cr_save"]', (e) => {
            e.preventDefault();

            const out = {
              delete: false,
              label: isCreate
                ? ($c.find('input[name="cr_label"]').val() ?? "").toString().trim()
                : (label ?? "CUSTOM"),
              value: Number($c.find('input[name="cr_value"]').val()) || 0,
              max: Number($c.find('input[name="cr_max"]').val()) || 0,
              left: ($c.find('input[name="cr_left"]').val() ?? left).toString(),
              right: ($c.find('input[name="cr_right"]').val() ?? right).toString()
            };

            finish(out);
            dlg.close();
          });

          $c.on("keydown", "input", (e) => {
            if (e.key === "Enter") $c.find('[data-action="cr_save"]').trigger("click");
            if (e.key === "Escape") $c.find('[data-action="cr_cancel"]').trigger("click");
          });
        },
        close: () => finish(null)
      },
      {
        classes: ["cr-spellpoints"],  // используем тот же “тёмный скин”
        width: isCreate ? 760 : 560,  // create чуть шире из-за поля name
        height: "auto"
      }
    );

    dlg.render(true);
  });
}
function promptColors(left, right) {
  return new Promise((resolve) => {
    new Dialog({
      title: "Bar Colors",
      content: `
        <form>
          <p style="display:flex;gap:8px;align-items:center;">
            <label style="flex:1;">Left<br><input name="left" type="color" value="${left}" style="width:100%"></label>
            <label style="flex:1;">Right<br><input name="right" type="color" value="${right}" style="width:100%"></label>
          </p>
        </form>
      `,
      buttons: {
        cancel: { label: "Cancel", callback: () => resolve(null) },
        ok: {
          label: "OK",
          callback: (html) => {
            const l = (html.find('input[name="left"]').val() ?? left).toString();
            const r = (html.find('input[name="right"]').val() ?? right).toString();
            resolve({ left: l, right: r });
          }
        }
      },
      default: "ok"
    }).render(true);
  });
}

function promptEditDeleteColors(label, value, max, left, right) {
  return promptResourceConfigDialog({
    mode: "edit",
    label,
    value,
    max,
    left,
    right
  }).then((out) => {
    if (!out) return null;
    if (out.delete) return { delete: true };
    return {
      delete: false,
      value: Number(out.value) || 0,
      max: Number(out.max) || 0,
      left: out.left,
      right: out.right
    };
  });
}


  // -------------------- Plus placement --------------------

  function ensurePlusNearSkull($html) {
  // remove duplicates anywhere (both sheets)
  $html.find(`[${ADD_BTN_ATTR}]`).remove();

  // --- Tidy 5e Sheet: put + near Spell Points cog in Favorites tab ---
  const $tidyLabel = $html
    .find(`.tidy-tab.favorites .sp-bar .label`)
    .first();

  if ($tidyLabel.length) {
    const $btn = $(`
      <a class="${MODULE_ID}__addbtn" ${ADD_BTN_ATTR} data-tooltip="Add custom resource" aria-label="Add custom resource">
        <i class="fa-solid fa-plus"></i>
      </a>
    `);

    const $spellPointsCog = $tidyLabel.find(`a.config-button.spellPoints`).first();
    if ($spellPointsCog.length) $spellPointsCog.after($btn);
    else $tidyLabel.append($btn);

    return;
  }

  // --- Default dnd5e sheet (existing behavior) ---
  let $skull = $html
    .find(`.sidebar i.fa-skull, .sidebar i.fas.fa-skull, .sidebar i.fa-skull-crossbones, .sidebar i.fas.fa-skull-crossbones`)
    .first();

  if (!$skull.length) {
    $skull = $html.find(`.sidebar .favorites i, .sidebar [data-action*="favorite"] i`).first();
  }

  let $mountPoint = $skull.length ? $skull.closest("a,button,div") : $html.find(".sidebar").first();
  if (!$mountPoint?.length) $mountPoint = $html.find(ROOT_SEL).first();
  if (!$mountPoint?.length) return;

  const $btn = $(`
    <a class="${MODULE_ID}__addbtn" ${ADD_BTN_ATTR} data-tooltip="Add custom resource" aria-label="Add custom resource">
      <i class="fa-solid fa-plus"></i>
    </a>
  `);

  if ($skull.length) $mountPoint.after($btn);
  else $mountPoint.append($btn);
}

  // -------------------- Manual create --------------------

  async function createStoredResource(actor, $html) {
    const label = await promptText("Resource name", "CUSTOM");
    if (label == null) return;

    const maxStr = await promptText("Max", "0");
    if (maxStr == null) return;

    const valStr = await promptText("Value", "0");
    if (valStr == null) return;

    const max = Number(maxStr) || 0;
    const value = Number(valStr) || 0;

    const resources = getResources(actor);
    resources.push({
      id: foundry.utils.randomID(),
      label: (label || "CUSTOM").trim(),
      mode: "stored",
      max,
      value
    });

    await saveResources(actor, resources);
    await renderResources(actor, $html);
  }

  // -------------------- Dialogs (V1) --------------------

  function promptText(title, initial) {
    return new Promise((resolve) => {
      new Dialog({
        title,
        content: `<input style="width:100%" type="text" value="${escapeHtml(initial ?? "")}">`,
        buttons: {
          cancel: { label: "Cancel", callback: () => resolve(null) },
          ok: { label: "OK", callback: (html) => resolve((html.find("input").val() ?? "").toString().trim()) }
        },
        default: "ok"
      }).render(true);
    });
  }

  function promptEditOrDelete(label, value, max) {
    return new Promise((resolve) => {
      new Dialog({
        title: `${label}`,
        content: `
          <form>
            <p style="display:flex;gap:8px;">
              <label style="flex:1;">Value<br><input name="value" type="number" value="${Number(value) || 0}" style="width:100%"></label>
              <label style="flex:1;">Max<br><input name="max" type="number" value="${Number(max) || 0}" style="width:100%"></label>
            </p>
          </form>
        `,
        buttons: {
          delete: { label: "Delete", callback: () => resolve({ delete: true }) },
          cancel: { label: "Cancel", callback: () => resolve(null) },
          save: {
            label: "Save",
            callback: (html) => {
              const v = Number(html.find('input[name="value"]').val()) || 0;
              const m = Number(html.find('input[name="max"]').val()) || 0;
              resolve({ delete: false, value: v, max: m });
            }
          }
        },
        default: "save"
      }).render(true);
    });
  }

  // -------------------- Utils --------------------

  function toJQ(html) {
    try {
      if (!html) return null;
      if (html instanceof jQuery) return html;
      if (html instanceof HTMLElement || html instanceof DocumentFragment) return $(html);
      if (html instanceof NodeList) return $(Array.from(html));
      if (Array.isArray(html)) return $(html);
      if (html?.element) return $(html.element);
      return $(html);
    } catch {
      return null;
    }
  }

  function escapeHtml(str) {
    return (str ?? "").replace(/[&<>"']/g, (m) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[m]));
  }
})();
