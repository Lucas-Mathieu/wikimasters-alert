(() => {
  "use strict";

  const alertAudio = new Audio(chrome.runtime.getURL("sounds/alert.wav"));
  alertAudio.preload = "auto";

  async function playSound() {
    alertAudio.pause();
    alertAudio.currentTime = 0;
    alertAudio.volume = 0.9;
    await alertAudio.play();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen" || message.type !== "PLAY_ALERT_SOUND") {
      return false;
    }

    playSound()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("WikiMasters Alert: lecture du son impossible", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  });
})();
