(() => {
  if (window.__instagramUnsendLoaded) return;
  window.__instagramUnsendLoaded = true;

  const SELECTOR = '[role="article"][aria-roledescription="message"]';
  const PREFIX = "See more options for message from ";
  const state = {
    running: false,
    stopRequested: false,
    phase: "idle",
    total: 0,
    completed: 0,
    skipped: 0,
    detail: "Open an Instagram DM to begin."
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function publish(phase, detail) {
    state.phase = phase;
    if (detail) state.detail = detail;
    try {
      browser.runtime.sendMessage({
        action: "UNSEND_PROGRESS",
        status: { ...state }
      }).catch(() => {});
    } catch (_) {}
  }

  function messages() {
    return [...document.querySelectorAll(SELECTOR)].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  // Instagram places the message's options controls beside the article, inside
  // its immediate wrapper. Keep this lookup narrow to avoid borrowing a
  // neighbouring message's controls.
  function optionsButton(message) {
    const row = message.parentElement;
    if (!row) return null;
    return [...row.querySelectorAll('[role="button"][aria-label]')]
      .find(el => (el.getAttribute("aria-label") || "").startsWith(PREFIX)) || null;
  }

  function sender(button) {
    const label = button?.getAttribute("aria-label") || "";
    return label.startsWith(PREFIX) ? label.slice(PREFIX.length).trim() : null;
  }

  function isOutgoing(message, username) {
    const row = message.parentElement;
    return Boolean(row &&
      getComputedStyle(row).flexDirection === "row-reverse" &&
      sender(optionsButton(message)) === username);
  }

  function identifyOwnSender(list) {
    const candidates = new Set();
    for (const message of list) {
      const row = message.parentElement;
      if (!row || getComputedStyle(row).flexDirection !== "row-reverse") continue;
      const name = sender(optionsButton(message));
      if (name) candidates.add(name);
    }
    if (candidates.size !== 1) {
      throw new Error(candidates.size
        ? "Multiple possible sender identities found. Nothing was unsent."
        : "Couldn't verify your account from the visible outgoing message controls. Scroll to a part of the conversation containing one of your messages and try again.");
    }
    return [...candidates][0];
  }

  function findScroller() {
    const list = messages();
    const candidates = [...document.querySelectorAll("*")].filter(el => {
      const style = getComputedStyle(el);
      if (!(["auto", "scroll"].includes(style.overflowY) &&
            style.flexDirection === "column-reverse")) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 150 && r.height >= 100 && el.clientHeight >= 100 &&
        el.scrollHeight > el.clientHeight + 40 &&
        list.some(message => el.contains(message));
    });
    candidates.sort((a, b) => a.clientHeight - b.clientHeight);
    return candidates[0] || null;
  }

  async function reachOldestHistory() {
    publish("loading", "Loading the oldest conversation history…");
    let stableAtOldest = 0;
    let previousHeight = -1;
    const maxAttempts = 240;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (state.stopRequested) return false;
      const scroller = findScroller();
      if (!scroller) throw new Error("Couldn't find the Instagram conversation scroller.");

      const beforeHeight = scroller.scrollHeight;
      // This is a column-reverse scroller: its oldest boundary is negative.
      scroller.scrollTop = -scroller.scrollHeight;
      scroller.dispatchEvent(new WheelEvent("wheel", {
        deltaY: -1400,
        bubbles: true
      }));
      await sleep(1100);

      const current = findScroller();
      if (!current) throw new Error("The conversation scroller disappeared while loading history.");
      const height = current.scrollHeight;
      const boundary = -(height - current.clientHeight);
      const atBoundary = Math.abs(current.scrollTop - boundary) < 5;
      const grew = height > beforeHeight + 2;

      if (grew || height !== previousHeight) {
        stableAtOldest = 0;
      } else if (atBoundary) {
        stableAtOldest++;
      } else {
        stableAtOldest = 0;
      }
      previousHeight = height;

      if (attempt % 5 === 0) {
        publish("loading", `Loading older messages… (${attempt + 1} scrolls, ${messages().length} currently rendered)`);
      }
      if (stableAtOldest >= 4) {
        publish("loading", "Reached the oldest available message. Starting unsend…");
        return true;
      }
    }

    throw new Error("Stopped at the history-loading safety limit. No messages were unsent; try again and allow more time for older history to load.");
  }

  function dialogs() {
    return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
  }

  function exactAction(root, label) {
    return [...root.querySelectorAll(
      'button, [role="button"], [role="menuitem"], [tabindex]'
    )].find(el => {
      const r = el.getBoundingClientRect();
      return (el.innerText || el.textContent || "").trim() === label &&
        r.width > 0 && r.height > 0;
    }) || null;
  }

  async function waitFor(fn, timeout = 2500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) return result;
      await sleep(100);
    }
    return null;
  }

  function escapeMenu() {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true
    }));
  }

  async function unsendOne(message) {
    if (!message.isConnected) return "gone";
    const row = message.parentElement;
    const button = optionsButton(message);
    const messageSender = sender(button);
    if (!row || getComputedStyle(row).flexDirection !== "row-reverse" ||
        !messageSender) return "skipped";

    button.click();
    const menu = await waitFor(() =>
      dialogs().find(dialog => exactAction(dialog, "Unsend"))
    );
    if (!menu) {
      escapeMenu();
      return "skipped";
    }

    const menuAction = exactAction(menu, "Unsend");
    if (!menuAction) {
      escapeMenu();
      return "skipped";
    }
    menuAction.click();

    const confirmation = await waitFor(() => dialogs().find(dialog => {
      const text = (dialog.innerText || "").toLowerCase();
      return text.includes("unsend message?") &&
        text.includes("remove the message for everyone");
    }));
    if (!confirmation) {
      escapeMenu();
      return "skipped";
    }

    const confirm = exactAction(confirmation, "Unsend");
    if (!confirm) {
      escapeMenu();
      return "skipped";
    }
    confirm.click();
    await sleep(800);
    return "success";
  }

  function skipKey(message, username) {
    const label = message.getAttribute("aria-labelledby") || "";
    const text = (message.innerText || message.textContent || "").trim();
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
    }
    const media = [
      message.querySelectorAll("img").length,
      message.querySelectorAll("video").length,
      message.querySelectorAll("audio").length
    ].join(":");
    return `${username}|${label}|${hash.toString(16)}|${media}`;
  }

  async function processVisibleBatch(username, processedKeys, delayMs) {
    // Always re-query after each action. Instagram recycles these nodes while
    // scrolling and may detach the element that was just unsent.
    while (!state.stopRequested) {
      const current = messages()
        .filter(message => isOutgoing(message, username))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

      const next = current.find(message => !processedKeys.has(skipKey(message, username)));
      if (!next) return;

      state.total++;
      const key = skipKey(next, username);
      const result = await unsendOne(next);

      if (result === "success") {
        processedKeys.add(key);
        state.completed++;
        publish("running", `Unsent ${state.completed} · skipped ${state.skipped} · scanning older-to-newer`);
        if (!state.stopRequested) {
          await sleep(delayMs);
        }
      } else if (result === "skipped") {
        processedKeys.add(key);
        state.skipped++;
        publish("running", `Unsent ${state.completed} · skipped ${state.skipped} · continuing`);
      } else {
        // The element disappeared between querying and acting. Re-query rather
        // than treating the stale node as a failed message.
        await sleep(150);
      }
    }
  }

  async function traverseOldestToNewest(username, delayMs) {
    const processedKeys = new Set();
    let steps = 0;
    let newestStablePasses = 0;
    const maxSteps = 3000;

    while (!state.stopRequested && steps < maxSteps) {
      const scroller = findScroller();
      if (!scroller) throw new Error("Couldn't find the conversation scroller while traversing.");

      await processVisibleBatch(username, processedKeys, delayMs);
      if (state.stopRequested) break;

      const currentScroller = findScroller();
      if (!currentScroller) throw new Error("The conversation scroller disappeared while traversing.");

      const before = currentScroller.scrollTop;
      const step = Math.max(100, Math.floor(currentScroller.clientHeight * 0.65));
      currentScroller.scrollTop = Math.min(0, before + step);
      currentScroller.dispatchEvent(new WheelEvent("wheel", {
        deltaY: 900,
        bubbles: true
      }));
      await sleep(850);

      const afterScroller = findScroller();
      if (!afterScroller) throw new Error("The conversation scroller disappeared while traversing.");
      const atNewest = afterScroller.scrollTop >= -3;
      const moved = Math.abs(afterScroller.scrollTop - before) > 2;

      if (atNewest && !moved) {
        newestStablePasses++;
      } else {
        newestStablePasses = 0;
      }

      steps++;
      if (steps % 5 === 0) {
        publish("running", `Unsent ${state.completed} · skipped ${state.skipped} · moving through conversation (${steps} batches)`);
      }

      if (atNewest && newestStablePasses >= 2) {
        // One final DOM pass at the newest end catches messages rendered after
        // the last scroll event.
        await processVisibleBatch(username, processedKeys, delayMs);
        return;
      }

      if (!moved && !atNewest) await sleep(700);
    }

    if (!state.stopRequested && steps >= maxSteps) {
      throw new Error("Stopped at the traversal safety limit. Some messages may remain; run it again to continue.");
    }
  }

  async function start(requestedDelayMs = 5000) {
    if (state.running) return;
    state.running = true;
    state.stopRequested = false;
    state.completed = 0;
    state.skipped = 0;
    state.total = 0;

    try {
      if (!location.pathname.startsWith("/direct/")) {
        throw new Error("Open an Instagram DM conversation first.");
      }
      const initial = messages();
      if (!initial.length) throw new Error("No messages found in this conversation.");

      // Identify the account from the currently rendered outgoing controls
      // before moving away from the current viewport.
      const username = identifyOwnSender(initial);
      const reachedOldest = await reachOldestHistory();
      if (!reachedOldest || state.stopRequested) {
        publish("stopped", "Stopped before unsending messages.");
        return;
      }

      publish("running", "Starting at the oldest message and moving toward the newest…");
      const delayMs = Number.isInteger(requestedDelayMs) &&
        requestedDelayMs >= 3000 && requestedDelayMs <= 7000
        ? requestedDelayMs
        : 5000;
      await traverseOldestToNewest(username, delayMs);

      publish(
        state.stopRequested ? "stopped" : "finished",
        `${state.stopRequested ? "Stopped" : "Finished"}. Unsent ${state.completed}; skipped ${state.skipped}.`
      );
    } catch (error) {
      publish("error", error.message || "Unexpected error.");
    } finally {
      state.running = false;
      state.stopRequested = false;
    }
  }

  browser.runtime.onMessage.addListener(message => {
    if (message.action === "START_UNSEND") {
      start(message.delayMs);
      return Promise.resolve({ success: true });
    }
    if (message.action === "STOP_UNSEND") {
      state.stopRequested = true;
      publish("stopping", "Stopping after the current action…");
      return Promise.resolve({ success: true });
    }
    if (message.action === "GET_UNSEND_STATUS") {
      return Promise.resolve({ ...state });
    }
    return undefined;
  });

  console.info("[Instagram Unsend] Ready.");
})();