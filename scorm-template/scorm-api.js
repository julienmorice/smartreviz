// SCORM 1.2 API Wrapper for Moodle LMS communication
var ScormAPI = (function () {
  var api = null;
  var initialized = false;

  function findAPI(win) {
    var attempts = 0;
    while (win && !win.API && attempts < 10) {
      if (win.parent && win.parent !== win) {
        win = win.parent;
      } else if (win.opener) {
        win = win.opener;
      } else {
        break;
      }
      attempts++;
    }
    return win && win.API ? win.API : null;
  }

  function init() {
    api = findAPI(window);
    if (api) {
      var result = api.LMSInitialize("");
      initialized = result === "true" || result === true;
    }
    if (!initialized) {
      console.warn("SCORM API not found — running in standalone mode");
    }
    return initialized;
  }

  function setValue(key, value) {
    if (api && initialized) {
      api.LMSSetValue(key, String(value));
      api.LMSCommit("");
    }
  }

  function getValue(key) {
    if (api && initialized) {
      return api.LMSGetValue(key);
    }
    return "";
  }

  function setStatus(status) {
    setValue("cmi.core.lesson_status", status);
  }

  function setLocation(location) {
    setValue("cmi.core.lesson_location", location);
  }

  function setScore(score) {
    setValue("cmi.core.score.raw", score);
    setValue("cmi.core.score.min", "0");
    setValue("cmi.core.score.max", "100");
  }

  function finish() {
    if (api && initialized) {
      api.LMSFinish("");
      initialized = false;
    }
  }

  return {
    init: init,
    setValue: setValue,
    getValue: getValue,
    setStatus: setStatus,
    setLocation: setLocation,
    setScore: setScore,
    finish: finish,
  };
})();
