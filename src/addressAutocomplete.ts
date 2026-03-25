import { type PhotonPlace, photonSearch } from "./photon";

export type AutocompleteOptions = {
  debounceMs?: number;
  minChars?: number;
  maxResults?: number;
  onSelect: (place: PhotonPlace) => void;
  /** Called when input is cleared or edited so much that selection is invalidated */
  onClear?: () => void;
};

/**
 * OpenStreetMap-backed suggestions via Photon (Komoot). Debounced; keyboard accessible.
 */
export type AddressAutocompleteHandle = {
  destroy: () => void;
  /** After setting the input programmatically (GPS, etc.), keep selection tracking in sync. */
  syncSelectionLabel: (label: string) => void;
};

export function attachAddressAutocomplete(
  input: HTMLInputElement,
  listEl: HTMLUListElement,
  options: AutocompleteOptions,
): AddressAutocompleteHandle {
  const debounceMs = options.debounceMs ?? 320;
  const minChars = options.minChars ?? 2;
  const maxResults = options.maxResults ?? 8;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let requestId = 0;
  let open = false;
  let items: PhotonPlace[] = [];
  let activeIndex = -1;
  let lastSelectedLabel = "";

  function close() {
    open = false;
    listEl.hidden = true;
    listEl.innerHTML = "";
    items = [];
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
  }

  function render() {
    listEl.innerHTML = "";
    items.forEach((place, i) => {
      const li = document.createElement("li");
      li.id = `${input.id}-opt-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === activeIndex ? "true" : "false");
      li.textContent = place.label;
      li.className = "autocomplete-item";
      if (i === activeIndex) li.classList.add("autocomplete-item-active");
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectIndex(i);
      });
      listEl.appendChild(li);
    });
    listEl.hidden = items.length === 0;
    open = items.length > 0;
    input.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function selectIndex(i: number) {
    const place = items[i];
    if (!place) return;
    lastSelectedLabel = place.label;
    input.value = place.label;
    close();
    options.onSelect(place);
  }

  async function runSearch(q: string) {
    const id = ++requestId;
    try {
      const results = await photonSearch(q, maxResults);
      if (id !== requestId) return;
      items = results;
      activeIndex = items.length > 0 ? 0 : -1;
      render();
      if (items.length && activeIndex >= 0) {
        input.setAttribute("aria-activedescendant", `${input.id}-opt-${activeIndex}`);
      }
    } catch {
      if (id !== requestId) return;
      items = [];
      close();
    }
  }

  function scheduleSearch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const q = input.value.trim();
      if (q.length < minChars) {
        close();
        return;
      }
      void runSearch(q);
    }, debounceMs);
  }

  function onInput() {
    const v = input.value.trim();
    if (v.length === 0) {
      if (timer) clearTimeout(timer);
      close();
      options.onClear?.();
      lastSelectedLabel = "";
      return;
    }
    // Only invalidate a prior list selection — not programmatic fills (e.g. GPS) where lastSelectedLabel is still empty.
    if (lastSelectedLabel && v !== lastSelectedLabel) {
      options.onClear?.();
    }
    scheduleSearch();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open || items.length === 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const q = input.value.trim();
        if (q.length >= minChars) void runSearch(q);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      render();
      input.setAttribute("aria-activedescendant", `${input.id}-opt-${activeIndex}`);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render();
      input.setAttribute("aria-activedescendant", `${input.id}-opt-${activeIndex}`);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0) selectIndex(activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function onBlur() {
    setTimeout(() => {
      if (!listEl.matches(":hover")) close();
    }, 150);
  }

  function onDocClick(ev: MouseEvent) {
    const t = ev.target as Node;
    if (t === input || listEl.contains(t)) return;
    close();
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("blur", onBlur);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  listEl.setAttribute("role", "listbox");
  document.addEventListener("click", onDocClick);

  function destroy() {
    if (timer) clearTimeout(timer);
    input.removeEventListener("input", onInput);
    input.removeEventListener("keydown", onKeyDown);
    input.removeEventListener("blur", onBlur);
    document.removeEventListener("click", onDocClick);
    close();
  }

  function syncSelectionLabel(label: string) {
    lastSelectedLabel = label;
  }

  return { destroy, syncSelectionLabel };
}
