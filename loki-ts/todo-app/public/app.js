(() => {
  const ICON_EDIT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const ICON_DELETE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';

  const EMPTY_COPY = {
    all: "Nothing on the list yet. Write the first thing down and it will be here when you come back.",
    active: "Nothing left open. Enjoy the quiet, or add the next thing.",
    done: "Nothing finished yet. Tick an item off and it will show up here.",
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    dateline: $("dateline"),
    form: $("add-form"),
    input: $("new-title"),
    list: $("todo-list"),
    empty: $("empty"),
    status: $("status"),
    clear: $("clear-done"),
    openCount: $("open-count"),
    openNote: $("open-note"),
    doneNote: $("done-note"),
    filters: document.querySelectorAll(".filters button"),
  };

  let filter = "all";

  els.dateline.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function showError(err) {
    els.status.textContent = err.message;
  }

  function iconButton(label, svg, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn";
    btn.setAttribute("aria-label", label);
    btn.innerHTML = svg;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function startEdit(todo, titleEl) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "todo-edit";
    input.maxLength = 200;
    input.value = todo.title;
    input.setAttribute("aria-label", "Edit item");
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const next = input.value.trim();
      if (save && next && next !== todo.title) {
        try {
          await api(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ title: next }) });
          els.status.textContent = "";
        } catch (err) {
          showError(err);
        }
      }
      await refresh();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  function renderTodo(todo) {
    const li = document.createElement("li");
    li.className = "todo" + (todo.done ? " is-done" : "");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "todo-check";
    check.checked = todo.done;
    check.setAttribute("aria-label", `Mark "${todo.title}" as ${todo.done ? "open" : "done"}`);
    check.addEventListener("change", async () => {
      try {
        await api(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ done: check.checked }) });
        els.status.textContent = "";
      } catch (err) {
        showError(err);
      }
      await refresh();
    });

    const title = document.createElement("p");
    title.className = "todo-title";
    title.textContent = todo.title;
    title.addEventListener("dblclick", () => startEdit(todo, title));

    const actions = document.createElement("div");
    actions.className = "todo-actions";
    actions.append(
      iconButton(`Edit "${todo.title}"`, ICON_EDIT, () => startEdit(todo, title)),
      iconButton(`Delete "${todo.title}"`, ICON_DELETE, async () => {
        try {
          await api(`/api/todos/${todo.id}`, { method: "DELETE" });
          els.status.textContent = "";
        } catch (err) {
          showError(err);
        }
        await refresh();
      }),
    );

    li.append(check, title, actions);
    return li;
  }

  function renderSummary(counts) {
    els.openCount.textContent = String(counts.active);
    els.openNote.textContent = counts.active === 1 ? "item open" : "items open";
    els.doneNote.textContent =
      counts.done === 0 ? "" : `${counts.done} finished of ${counts.total} written down.`;
    els.clear.hidden = counts.done === 0;
  }

  async function refresh() {
    try {
      const { todos, counts } = await api(`/api/todos?filter=${filter}`);
      els.list.replaceChildren(...todos.map(renderTodo));
      els.empty.hidden = todos.length > 0;
      els.empty.textContent = todos.length > 0 ? "" : EMPTY_COPY[filter];
      renderSummary(counts);
    } catch (err) {
      showError(err);
    }
  }

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = els.input.value.trim();
    if (!title) return;
    try {
      await api("/api/todos", { method: "POST", body: JSON.stringify({ title }) });
      els.input.value = "";
      els.status.textContent = "";
    } catch (err) {
      showError(err);
    }
    await refresh();
    els.input.focus();
  });

  els.clear.addEventListener("click", async () => {
    try {
      await api("/api/todos?completed=true", { method: "DELETE" });
      els.status.textContent = "";
    } catch (err) {
      showError(err);
    }
    await refresh();
  });

  els.filters.forEach((btn) =>
    btn.addEventListener("click", () => {
      filter = btn.dataset.filter;
      els.filters.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      refresh();
    }),
  );

  refresh();
})();
