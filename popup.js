const button = document.getElementById("toggle");
const statusText = document.getElementById("status");
const delaySelect = document.getElementById("delay");

let tabId = null;
let running = false;

async function message(action, extra = {}) {
  return browser.tabs.sendMessage(tabId, { action, ...extra });
}

async function refresh() {
  if (!tabId) return;
  try {
    const s = await message("GET_UNSEND_STATUS");
    running = Boolean(s.running) ||
      ["loading", "running", "stopping"].includes(s.phase);
    statusText.textContent = s.detail || "Ready.";
    button.textContent = running ? "Stop" : "Unsend all";
    button.classList.toggle("stop", running);
    delaySelect.disabled = running;
  } catch (_) {
    statusText.textContent = "Reload the Instagram tab and try again.";
    button.disabled = true;
    delaySelect.disabled = true;
  }
}

button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    if (running) {
      await message("STOP_UNSEND");
      statusText.textContent = "Stopping…";
    } else {
      if (!window.confirm(
        "Unsend all messages you sent in this conversation? " +
        "This removes them for everyone and cannot be undone."
      )) return;

      const delayMs = Number(delaySelect.value);
      await message("START_UNSEND", { delayMs });
      statusText.textContent = `Starting with a ${delayMs / 1000}-second delay…`;
    }
  } catch (error) {
    statusText.textContent = error.message || "Unable to start.";
  } finally {
    button.disabled = false;
    await refresh();
  }
});

(async () => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://www.instagram.com/")) {
      throw new Error("Open Instagram first.");
    }
    if (!tab.url.includes("/direct/")) {
      throw new Error("Open an Instagram DM conversation first.");
    }
    tabId = tab.id;
    await refresh();
    setInterval(refresh, 800);
  } catch (error) {
    statusText.textContent = error.message;
    button.disabled = true;
    delaySelect.disabled = true;
  }
})();