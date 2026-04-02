// IMT-BS SmartReviz — Main Application Logic
(function () {
  "use strict";

  // Configure PDF.js worker path
  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
  }

  // --- Proxy Cloudflare Worker ---
  var PROXY_URL = "https://smartreviz-proxy.julienmorice.workers.dev";

  // --- DOM Elements ---
  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  var dzText = document.getElementById("dzText");
  var toggleTextBtn = document.getElementById("toggleTextInput");
  var textInputArea = document.getElementById("textInputArea");
  var textInput = document.getElementById("textInput");
  var moduleTitleInput = document.getElementById("moduleTitle");
  var moduleLangSelect = document.getElementById("moduleLang");
  var btnGenerate = document.getElementById("btnGenerate");
  var progressPanel = document.getElementById("progressPanel");
  var progressFill = document.getElementById("progressFill");
  var progressStatus = document.getElementById("progressStatus");
  var errorPanel = document.getElementById("errorPanel");
  var errorMessage = document.getElementById("errorMessage");
  var resultPanel = document.getElementById("resultPanel");
  var btnDownload = document.getElementById("btnDownload");
  var btnDownloadHTML = document.getElementById("btnDownloadHTML");
  var btnPreview = document.getElementById("btnPreview");

  // --- State ---
  var extractedText = "";
  var selectedFile = null;
  var generatedZipBlob = null;
  var generatedModuleHTML = "";
  var pendingModuleData = null;
  var pendingTitle = "";
  var pendingLang = "";

  // --- SCORM Template Cache ---
  var scormTemplateCache = {};

  // --- Editor DOM refs ---
  var editorPanel = document.getElementById("editorPanel");
  var btnValidateGenerate = document.getElementById("btnValidateGenerate");

  // --- Dropzone ---
  dropzone.addEventListener("click", function () {
    fileInput.click();
  });

  dropzone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", function () {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files.length > 0) {
      handleFile(fileInput.files[0]);
    }
  });

  function handleFile(file) {
    var ext = file.name.split(".").pop().toLowerCase();
    if (["txt", "md", "docx", "pdf"].indexOf(ext) === -1) {
      showError(SmartRevizI18n.t("errUnsupportedFormat"));
      return;
    }
    selectedFile = file;
    dropzone.classList.add("has-file");
    dzText.textContent = file.name;
    // Pre-fill title from filename
    if (!moduleTitleInput.value) {
      var name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
      moduleTitleInput.value = name;
    }
    // Hide text input if visible
    textInputArea.classList.remove("active");
    textInput.value = "";
  }

  // --- Text toggle ---
  toggleTextBtn.addEventListener("click", function () {
    textInputArea.classList.toggle("active");
    if (textInputArea.classList.contains("active")) {
      selectedFile = null;
      dropzone.classList.remove("has-file");
      dzText.textContent = SmartRevizI18n.t("dzText");
      fileInput.value = "";
    }
  });

  // --- File Extraction ---
  function extractTextFromFile(file) {
    return new Promise(function (resolve, reject) {
      var ext = file.name.split(".").pop().toLowerCase();

      if (ext === "txt" || ext === "md") {
        var reader = new FileReader();
        reader.onload = function (e) {
          resolve(e.target.result);
        };
        reader.onerror = function () {
          reject(new Error(SmartRevizI18n.t("errFileRead")));
        };
        reader.readAsText(file);
      } else if (ext === "docx") {
        var reader2 = new FileReader();
        reader2.onload = function (e) {
          mammoth
            .extractRawText({ arrayBuffer: e.target.result })
            .then(function (result) {
              resolve(result.value);
            })
            .catch(reject);
        };
        reader2.onerror = function () {
          reject(new Error(SmartRevizI18n.t("errFileReadDOCX")));
        };
        reader2.readAsArrayBuffer(file);
      } else if (ext === "pdf") {
        var reader3 = new FileReader();
        reader3.onload = function (e) {
          var typedArray = new Uint8Array(e.target.result);
          pdfjsLib.getDocument(typedArray).promise.then(function (pdf) {
            var pages = [];
            var total = pdf.numPages;
            var processed = 0;
            for (var i = 1; i <= total; i++) {
              (function (pageNum) {
                pdf.getPage(pageNum).then(function (page) {
                  page.getTextContent().then(function (content) {
                    var text = content.items
                      .map(function (item) {
                        return item.str;
                      })
                      .join(" ");
                    pages[pageNum - 1] = text;
                    processed++;
                    if (processed === total) {
                      resolve(pages.join("\n\n"));
                    }
                  });
                });
              })(i);
            }
          }).catch(reject);
        };
        reader3.onerror = function () {
          reject(new Error(SmartRevizI18n.t("errFileReadPDF")));
        };
        reader3.readAsArrayBuffer(file);
      } else {
        reject(new Error(SmartRevizI18n.t("errUnsupportedFormat")));
      }
    });
  }

  // --- Claude API Call (via proxy Cloudflare Worker) ---
  function callClaudeAPI(text, language) {
    var langLabel = language === "fr" ? "Français" : "English";

    var systemPrompt =
      "Tu es un assistant pédagogique spécialisé dans la création de modules de révision.\n" +
      "À partir du contenu de cours fourni, tu DOIS générer un objet JSON contenant EXACTEMENT ces 4 clés :\n\n" +
      '1. "summary" : un objet avec 3 clés :\n' +
      '   - "overview" : string — un paragraphe de synthèse complet (6 à 8 phrases) couvrant l\'ensemble du document : contexte, enjeux principaux, structure du cours et apports clés. Rédigé en prose fluide, sans liste ni bullet point.\n' +
      '   - "keyPoints" : tableau de 4 à 6 strings — les points clés essentiels du cours. Chaque point est une phrase complète et autonome (sujet + verbe + complément), qui apporte une information substantielle, pas un simple titre de rubrique.\n' +
      '   - "chapters" : tableau de 4 à 8 chapitres thématiques couvrant l\'ensemble du document. Chaque chapitre a :\n' +
      '       * "title" : string — titre thématique clair du chapitre\n' +
      '       * "sections" : tableau de 1 à 3 objets, chacun avec :\n' +
      '           - "title" : string — sous-titre de la section\n' +
      '           - "content" : string — paragraphe rédigé de 4 à 6 phrases complètes expliquant en détail le contenu de cette section. Ce contenu doit être informatif, précis, et rédigé en prose continue (pas de listes, pas de mots-clés isolés). Il doit mentionner des faits, chiffres, noms ou exemples concrets tirés du document source.\n\n' +
      '2. "glossary" : tableau de 10 à 15 objets, chacun avec "term" (string) et "definition" (string — définition complète en 2-3 phrases).\n\n' +
      '3. "flashcards" : tableau de EXACTEMENT 10 objets. Chaque objet a "type" ("concept" ou "question"), "front" (string) et "back" (string — réponse développée en 2-3 phrases). Mélange les deux types.\n\n' +
      '4. "quiz" : tableau de EXACTEMENT 10 objets. Chaque objet a :\n' +
      '   - "question" : string (l\'énoncé)\n' +
      '   - "choices" : tableau de exactement 4 strings\n' +
      '   - "correct" : integer (0, 1, 2 ou 3 — index de la bonne réponse)\n' +
      '   - "explanation" : string (explication de 2-3 phrases justifiant la bonne réponse)\n\n' +
      "Langue de sortie : " + langLabel + "\n\n" +
      "Règles STRICTES :\n" +
      "- Tu DOIS inclure les 4 sections : summary, glossary, flashcards ET quiz\n" +
      "- flashcards : EXACTEMENT 10 cartes, ni plus ni moins\n" +
      "- quiz : EXACTEMENT 10 questions, ni plus ni moins\n" +
      "- INTERDIT dans le résumé : listes à puces, tirets, mots-clés isolés, phrases incomplètes. Uniquement de la prose rédigée.\n" +
      "- Chaque section du résumé doit être substantielle : mentionner des informations précises (noms, dates, chiffres, exemples) tirées du document source\n" +
      "- Les questions doivent tester la compréhension, pas la mémorisation de détails\n" +
      "- Les distracteurs (mauvaises réponses) doivent être plausibles\n" +
      "- Les flashcards doivent couvrir les concepts fondamentaux\n" +
      "- Le glossaire doit contenir les termes techniques essentiels avec des définitions complètes\n\n" +
      "IMPORTANT : Réponds UNIQUEMENT avec l'objet JSON brut. Pas de ```json, pas de commentaire, pas de texte avant ou après. Juste le JSON.";

    // Truncate if necessary (~100K chars ≈ ~25K tokens)
    var maxChars = 400000;
    if (text.length > maxChars) {
      text = text.substring(0, maxChars);
    }

    return fetch(PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content:
              (language === "fr"
                ? "Voici le contenu du cours à transformer en module de révision :\n\n"
                : "Here is the course content to transform into a revision module:\n\n") +
              text,
          },
        ],
        system: systemPrompt,
      }),
    })
      .then(function (response) {
        return response.text().then(function (text) {
          var data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            if (response.status === 524) {
              throw new Error(SmartRevizI18n.t("errTimeout"));
            }
            throw new Error("API Error (" + response.status + "): " + text.substring(0, 200));
          }
          if (!response.ok) {
            throw new Error(
              data.error
                ? data.error.message
                : "API Error (" + response.status + ")"
            );
          }
          return data;
        });
      })
      .then(function (data) {
        var content = data.content[0].text;
        // Remove potential markdown code block wrapping
        content = content.replace(/^```json?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
        var parsed = JSON.parse(content);

        // Validate required sections exist
        if (!parsed.summary || !parsed.summary.chapters || !Array.isArray(parsed.summary.chapters)) {
          throw new Error(SmartRevizI18n.t("errSummary"));
        }
        if (!parsed.glossary || !Array.isArray(parsed.glossary) || parsed.glossary.length === 0) {
          throw new Error(SmartRevizI18n.t("errGlossary"));
        }
        if (!parsed.flashcards || !Array.isArray(parsed.flashcards) || parsed.flashcards.length === 0) {
          throw new Error(SmartRevizI18n.t("errFlashcards"));
        }
        if (!parsed.quiz || !Array.isArray(parsed.quiz) || parsed.quiz.length === 0) {
          throw new Error(SmartRevizI18n.t("errQuiz"));
        }

        console.log("SmartReviz — Données générées :",
          parsed.summary.chapters.length, "chapitres,",
          parsed.glossary.length, "termes,",
          parsed.flashcards.length, "flashcards,",
          parsed.quiz.length, "questions QCM");

        return parsed;
      });
  }

  // --- Load SCORM Template Files ---
  function loadScormTemplate() {
    var files = [
      "scorm-template/index.html",
      "scorm-template/style.css",
      "scorm-template/scorm-api.js",
      "scorm-template/module-data.js",
    ];

    var promises = files.map(function (path) {
      return fetch(path)
        .then(function (r) {
          return r.text();
        })
        .then(function (text) {
          scormTemplateCache[path.split("/").pop()] = text;
        });
    });

    return Promise.all(promises);
  }

  // --- Build SCORM Package ---
  function buildScormPackage(moduleData, title) {
    var zip = new JSZip();

    // imsmanifest.xml
    var uuid = "sr_" + Date.now() + "_" + Math.random().toString(36).substr(2, 8);
    var safeTitle = escapeXML(title);
    var manifest =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<manifest identifier="SmartReviz_' + uuid + '" version="1.0"\n' +
      '  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"\n' +
      '  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">\n' +
      "  <metadata>\n" +
      "    <schema>ADL SCORM</schema>\n" +
      "    <schemaversion>1.2</schemaversion>\n" +
      "  </metadata>\n" +
      '  <organizations default="smartreviz_org">\n' +
      '    <organization identifier="smartreviz_org">\n' +
      "      <title>" + safeTitle + "</title>\n" +
      '      <item identifier="item_1" identifierref="resource_1">\n' +
      "        <title>" + safeTitle + "</title>\n" +
      "      </item>\n" +
      "    </organization>\n" +
      "  </organizations>\n" +
      "  <resources>\n" +
      '    <resource identifier="resource_1" type="webcontent"\n' +
      '      adlcp:scormtype="sco" href="index.html">\n' +
      '      <file href="index.html"/>\n' +
      '      <file href="scorm-api.js"/>\n' +
      '      <file href="module-data.js"/>\n' +
      '      <file href="style.css"/>\n' +
      "    </resource>\n" +
      "  </resources>\n" +
      "</manifest>";
    zip.file("imsmanifest.xml", manifest);

    // module-data.js with actual data
    var dataJS =
      "var MODULE_DATA = " + JSON.stringify(moduleData, null, 2) + ";";
    zip.file("module-data.js", dataJS);

    // Template files
    zip.file("index.html", scormTemplateCache["index.html"]);
    zip.file("style.css", scormTemplateCache["style.css"]);
    zip.file("scorm-api.js", scormTemplateCache["scorm-api.js"]);

    return zip.generateAsync({ type: "blob" });
  }

  // --- Preview ---
  function buildPreviewHTML(moduleData) {
    var html = scormTemplateCache["index.html"];
    var dataJS =
      "var MODULE_DATA = " + JSON.stringify(moduleData, null, 2) + ";";
    // Replace the script src for module-data.js with inline script
    html = html.replace(
      '<script src="module-data.js"></script>',
      "<script>" + dataJS + "</" + "script>"
    );
    // Replace the script src for scorm-api.js with inline script
    html = html.replace(
      '<script src="scorm-api.js"></script>',
      "<script>" + scormTemplateCache["scorm-api.js"] + "</" + "script>"
    );
    // Inline CSS
    html = html.replace(
      '<link rel="stylesheet" href="style.css">',
      "<style>" + scormTemplateCache["style.css"] + "</style>"
    );
    return html;
  }

  // --- Generate ---
  btnGenerate.addEventListener("click", function () {
    hideError();
    resultPanel.classList.remove("active");

    var hasText = textInput.value.trim().length > 0;
    if (!selectedFile && !hasText) {
      showError(SmartRevizI18n.t("errNoInput"));
      return;
    }

    var title =
      moduleTitleInput.value.trim() || SmartRevizI18n.t("defaultTitle");
    var lang = moduleLangSelect.value;

    btnGenerate.disabled = true;
    showProgress(10, SmartRevizI18n.t("progressExtracting"));

    // Step 1: Extract text
    var textPromise;
    if (hasText) {
      textPromise = Promise.resolve(textInput.value.trim());
    } else {
      textPromise = extractTextFromFile(selectedFile);
    }

    textPromise
      .then(function (text) {
        if (!text || text.trim().length < 50) {
          throw new Error(SmartRevizI18n.t("errTextTooShort"));
        }
        extractedText = text;
        showProgress(25, SmartRevizI18n.t("progressLoadingTemplates"));
        return loadScormTemplate();
      })
      .then(function () {
        // Animate progress from 35% to 80% over ~30s during API call
        startAnimatedProgress(35, 80, 30000, SmartRevizI18n.t("progressCallingAPI"));
        return callClaudeAPI(extractedText, lang);
      })
      .then(function (moduleData) {
        stopAnimatedProgress();
        moduleData.title = title;
        moduleData.language = lang;
        pendingModuleData = moduleData;
        pendingTitle = title;
        pendingLang = lang;

        progressPanel.classList.remove("active");
        showEditor(moduleData);
        btnGenerate.disabled = false;
      })
      .catch(function (err) {
        stopAnimatedProgress();
        progressPanel.classList.remove("active");
        showError(err.message || SmartRevizI18n.t("errGeneric"));
        btnGenerate.disabled = false;
      });
  });

  // --- Download ---
  btnDownload.addEventListener("click", function () {
    if (!generatedZipBlob) return;
    var title = moduleTitleInput.value.trim() || "module_revision";
    var safeName = title.replace(/[^a-zA-Z0-9àâäéèêëïîôùûüÿçÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ\s_-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50);
    var a = document.createElement("a");
    a.href = URL.createObjectURL(generatedZipBlob);
    a.download = safeName + "_SCORM.zip";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // --- Download HTML ---
  btnDownloadHTML.addEventListener("click", function () {
    if (!generatedModuleHTML) return;
    var title = moduleTitleInput.value.trim() || "module_revision";
    var safeName = title.replace(/[^a-zA-Z0-9àâäéèêëïîôùûüÿçÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ\s_-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50);
    var blob = new Blob([generatedModuleHTML], { type: "text/html;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = safeName + ".html";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // --- Preview ---
  btnPreview.addEventListener("click", function () {
    if (!generatedModuleHTML) return;
    var win = window.open("", "_blank");
    win.document.open();
    win.document.write(generatedModuleHTML);
    win.document.close();
  });

  // ============================================================
  // EDITOR
  // ============================================================

  function showEditor(data) {
    editorPanel.classList.add("active");
    renderTabSummary(data.summary);
    renderTabGlossary(data.glossary);
    renderTabFlashcards(data.flashcards);
    renderTabQuiz(data.quiz);
    editorPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // --- Tab switching ---
  document.getElementById("editorTabs").addEventListener("click", function(e) {
    var btn = e.target.closest(".tab-btn");
    if (!btn) return;
    var tab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".tab-content").forEach(function(c) { c.classList.remove("active"); });
    btn.classList.add("active");
    document.getElementById("tab-" + tab).classList.add("active");
  });

  // --- SUMMARY TAB ---
  function renderTabSummary(summary) {
    var el = document.getElementById("tab-summary");
    var html = "";

    // Overview
    html += '<div class="editor-section-label">' + esc(SmartRevizI18n.t("edOverview")) + '</div>';
    html += '<textarea id="ed-overview" rows="6">' + esc(summary.overview || "") + '</textarea>';

    // Key points
    html += '<div class="editor-section-label">' + esc(SmartRevizI18n.t("edKeyPoints")) + '</div>';
    html += '<div id="ed-keypoints">';
    (summary.keyPoints || []).forEach(function(kp, i) {
      html += keypointRow(kp, i);
    });
    html += '</div>';
    html += '<button class="btn-add-row" id="btnAddKeypoint">' + esc(SmartRevizI18n.t("addKeypoint")) + '</button>';

    // Chapters
    html += '<div class="editor-section-label" style="margin-top:20px">' + esc(SmartRevizI18n.t("edChapters")) + '</div>';
    html += '<div id="ed-chapters">';
    (summary.chapters || []).forEach(function(ch, ci) {
      html += chapterBlock(ch, ci);
    });
    html += '</div>';
    html += '<button class="btn-add-row" id="btnAddChapter">' + esc(SmartRevizI18n.t("addChapter")) + '</button>';

    el.innerHTML = html;

    // Events: key points
    document.getElementById("btnAddKeypoint").addEventListener("click", function() {
      var container = document.getElementById("ed-keypoints");
      var idx = container.querySelectorAll(".keypoint-row").length;
      var div = document.createElement("div");
      div.innerHTML = keypointRow("", idx);
      container.appendChild(div.firstChild);
      bindDeleteBtns(container);
    });

    // Events: chapters
    document.getElementById("btnAddChapter").addEventListener("click", function() {
      var container = document.getElementById("ed-chapters");
      var idx = container.querySelectorAll(".chapter-block").length;
      var div = document.createElement("div");
      div.innerHTML = chapterBlock({ title: SmartRevizI18n.t("newChapter"), sections: [{ title: "", content: "" }] }, idx);
      container.appendChild(div.firstChild);
      bindChapterEvents(container.lastElementChild, idx);
      bindDeleteBtns(container);
    });

    bindDeleteBtns(document.getElementById("ed-keypoints"));
    document.querySelectorAll(".chapter-block").forEach(function(block, ci) {
      bindChapterEvents(block, ci);
    });
    bindDeleteBtns(document.getElementById("ed-chapters"));
  }

  function keypointRow(value, idx) {
    return '<div class="keypoint-row" data-idx="' + idx + '">' +
      '<input type="text" class="kp-input" value="' + esc(value) + '" placeholder="' + esc(SmartRevizI18n.t("placeholderKeypoint")) + '">' +
      '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteTooltip")) + '">&#215;</button>' +
    '</div>';
  }

  function chapterBlock(ch, ci) {
    var html = '<div class="chapter-block" data-ci="' + ci + '">';
    html += '<div class="chapter-block-header">';
    html += '<input type="text" class="ch-title" value="' + esc(ch.title || "") + '" placeholder="' + esc(SmartRevizI18n.t("placeholderChapterTitle")) + '">';
    html += '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteChapterTooltip")) + '">&#215;</button>';
    html += '</div>';
    html += '<div class="chapter-sections" data-ci="' + ci + '">';
    (ch.sections || []).forEach(function(sec, si) {
      html += sectionBlock(sec, ci, si);
    });
    html += '</div>';
    html += '<button class="btn-add-row btn-add-section" style="font-size:12px;padding:5px 10px">' + esc(SmartRevizI18n.t("addSection")) + '</button>';
    html += '</div>';
    return html;
  }

  function sectionBlock(sec, ci, si) {
    return '<div class="section-block" data-si="' + si + '">' +
      '<div class="section-block-fields">' +
        '<input type="text" class="sec-title" value="' + esc(sec.title || "") + '" placeholder="' + esc(SmartRevizI18n.t("placeholderSectionTitle")) + '">' +
        '<textarea class="sec-content" rows="6">' + esc(sec.content || "") + '</textarea>' +
      '</div>' +
      '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteSectionTooltip")) + '">&#215;</button>' +
    '</div>';
  }

  function bindChapterEvents(block, ci) {
    var addBtn = block.querySelector(".btn-add-section");
    if (!addBtn) return;
    addBtn.addEventListener("click", function() {
      var secContainer = block.querySelector(".chapter-sections");
      var si = secContainer.querySelectorAll(".section-block").length;
      var div = document.createElement("div");
      div.innerHTML = sectionBlock({ title: "", content: "" }, ci, si);
      secContainer.appendChild(div.firstChild);
      bindDeleteBtns(secContainer);
    });
    bindDeleteBtns(block.querySelector(".chapter-sections"));
  }

  function bindDeleteBtns(container) {
    container.querySelectorAll(".btn-row-delete").forEach(function(btn) {
      btn.onclick = function() {
        var row = btn.closest(".keypoint-row, .chapter-block, .section-block, .editor-row, .quiz-editor-item");
        if (row) row.remove();
      };
    });
  }

  // --- GLOSSARY TAB ---
  function renderTabGlossary(glossary) {
    var el = document.getElementById("tab-glossary");
    document.getElementById("countGlossary").textContent = glossary.length;
    var html = '<div id="ed-glossary">';
    glossary.forEach(function(item, i) {
      html += glossaryRow(item, i);
    });
    html += '</div>';
    html += '<button class="btn-add-row" id="btnAddGloss">' + esc(SmartRevizI18n.t("addTerm")) + '</button>';
    el.innerHTML = html;

    document.getElementById("btnAddGloss").addEventListener("click", function() {
      var container = document.getElementById("ed-glossary");
      var idx = container.querySelectorAll(".editor-row").length;
      var div = document.createElement("div");
      div.innerHTML = glossaryRow({ term: "", definition: "" }, idx);
      container.appendChild(div.firstChild);
      bindDeleteBtns(container);
      document.getElementById("countGlossary").textContent = container.querySelectorAll(".editor-row").length;
    });

    bindDeleteBtns(document.getElementById("ed-glossary"));
  }

  function glossaryRow(item, i) {
    return '<div class="editor-row" data-idx="' + i + '">' +
      '<div class="editor-row-fields">' +
        '<input type="text" class="gloss-term" value="' + esc(item.term || "") + '" placeholder="' + esc(SmartRevizI18n.t("placeholderTerm")) + '">' +
        '<textarea class="gloss-def" rows="2">' + esc(item.definition || "") + '</textarea>' +
      '</div>' +
      '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteTooltip")) + '">&#215;</button>' +
    '</div>';
  }

  // --- FLASHCARDS TAB ---
  function renderTabFlashcards(flashcards) {
    var el = document.getElementById("tab-flashcards");
    document.getElementById("countFlashcards").textContent = flashcards.length;
    var html = '<div id="ed-flashcards">';
    flashcards.forEach(function(fc, i) {
      html += flashcardRow(fc, i);
    });
    html += '</div>';
    html += '<button class="btn-add-row" id="btnAddFC">' + esc(SmartRevizI18n.t("addFlashcard")) + '</button>';
    el.innerHTML = html;

    document.getElementById("btnAddFC").addEventListener("click", function() {
      var container = document.getElementById("ed-flashcards");
      var idx = container.querySelectorAll(".editor-row").length;
      var div = document.createElement("div");
      div.innerHTML = flashcardRow({ type: "concept", front: "", back: "" }, idx);
      container.appendChild(div.firstChild);
      bindDeleteBtns(container);
      document.getElementById("countFlashcards").textContent = container.querySelectorAll(".editor-row").length;
    });

    bindDeleteBtns(document.getElementById("ed-flashcards"));
  }

  function flashcardRow(fc, i) {
    return '<div class="editor-row" data-idx="' + i + '">' +
      '<div class="editor-row-fields">' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">' +
          '<span style="font-size:12px;font-weight:600;color:#6B7280">' + esc(SmartRevizI18n.t("labelType")) + '</span>' +
          '<select class="fc-type" style="width:auto;padding:4px 8px;font-size:12px">' +
            '<option value="concept"' + (fc.type === "concept" ? " selected" : "") + '>' + esc(SmartRevizI18n.t("typeConcept")) + '</option>' +
            '<option value="question"' + (fc.type === "question" ? " selected" : "") + '>' + esc(SmartRevizI18n.t("typeQuestion")) + '</option>' +
          '</select>' +
        '</div>' +
        '<input type="text" class="fc-front" value="' + esc(fc.front || "") + '" placeholder="' + esc(SmartRevizI18n.t("placeholderFront")) + '">' +
        '<textarea class="fc-back" rows="2">' + esc(fc.back || "") + '</textarea>' +
      '</div>' +
      '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteTooltip")) + '">&#215;</button>' +
    '</div>';
  }

  // --- QUIZ TAB ---
  function renderTabQuiz(quiz) {
    var el = document.getElementById("tab-quiz");
    document.getElementById("countQuiz").textContent = quiz.length;
    var html = '<div id="ed-quiz">';
    quiz.forEach(function(q, i) {
      html += quizEditorItem(q, i);
    });
    html += '</div>';
    html += '<button class="btn-add-row" id="btnAddQ">' + esc(SmartRevizI18n.t("addQuestion")) + '</button>';
    el.innerHTML = html;

    // Accordion
    el.querySelectorAll(".quiz-editor-header").forEach(function(header) {
      header.addEventListener("click", function() {
        var item = header.closest(".quiz-editor-item");
        item.classList.toggle("open");
      });
    });

    // Auto-update preview text on question input
    el.querySelectorAll(".quiz-q-input").forEach(function(input) {
      input.addEventListener("input", function() {
        var item = input.closest(".quiz-editor-item");
        var preview = item.querySelector(".quiz-editor-preview");
        preview.textContent = input.value || SmartRevizI18n.t("questionPlaceholder");
      });
    });

    document.getElementById("btnAddQ").addEventListener("click", function() {
      var container = document.getElementById("ed-quiz");
      var idx = container.querySelectorAll(".quiz-editor-item").length;
      var q = { question: "", choices: ["", "", "", ""], correct: 0, explanation: "" };
      var div = document.createElement("div");
      div.innerHTML = quizEditorItem(q, idx);
      container.appendChild(div.firstChild);
      var newItem = container.lastElementChild;
      newItem.querySelector(".quiz-editor-header").addEventListener("click", function() {
        newItem.classList.toggle("open");
      });
      newItem.querySelector(".quiz-q-input").addEventListener("input", function(e) {
        newItem.querySelector(".quiz-editor-preview").textContent = e.target.value || SmartRevizI18n.t("questionPlaceholder");
      });
      bindDeleteBtns(container);
      document.getElementById("countQuiz").textContent = container.querySelectorAll(".quiz-editor-item").length;
      newItem.classList.add("open");
    });

    bindDeleteBtns(document.getElementById("ed-quiz"));
  }

  function quizEditorItem(q, i) {
    var choices = q.choices || ["", "", "", ""];
    var letters = ["A", "B", "C", "D"];
    var html = '<div class="quiz-editor-item" data-idx="' + i + '">';
    html += '<div class="quiz-editor-header">';
    html += '<span class="quiz-editor-num">' + (i + 1) + '</span>';
    html += '<span class="quiz-editor-preview">' + esc(q.question || SmartRevizI18n.t("questionPlaceholder")) + '</span>';
    html += '<span class="quiz-editor-toggle">&#9660;</span>';
    html += '</div>';
    html += '<div class="quiz-editor-body">';
    html += '<textarea class="quiz-q-input" rows="2" placeholder="' + esc(SmartRevizI18n.t("placeholderQuestionText")) + '" style="margin-top:10px">' + esc(q.question || "") + '</textarea>';
    html += '<div class="editor-section-label" style="margin-top:12px">' + esc(SmartRevizI18n.t("labelChoices")) + '</div>';
    html += '<div class="quiz-choices-grid">';
    choices.forEach(function(c, ci) {
      html += '<div class="quiz-choice-row">';
      html += '<label>' + letters[ci] + '</label>';
      html += '<input type="text" class="quiz-c-input" data-ci="' + ci + '" value="' + esc(c) + '" placeholder="' + esc(SmartRevizI18n.t("placeholderAnswer")) + ' ' + letters[ci] + '">';
      html += '</div>';
    });
    html += '</div>';
    html += '<div class="quiz-correct-row">';
    html += '<label>' + esc(SmartRevizI18n.t("labelCorrectAnswer")) + '</label>';
    html += '<select class="quiz-correct-sel">';
    letters.forEach(function(l, li) {
      html += '<option value="' + li + '"' + (q.correct === li ? " selected" : "") + '>' + l + '</option>';
    });
    html += '</select>';
    html += '</div>';
    html += '<div class="editor-section-label" style="margin-top:10px">' + esc(SmartRevizI18n.t("labelExplanation")) + '</div>';
    html += '<textarea class="quiz-expl-input" rows="2" placeholder="' + esc(SmartRevizI18n.t("placeholderExplanation")) + '">' + esc(q.explanation || "") + '</textarea>';
    html += '<div class="quiz-delete-row"><button class="btn-row-delete" style="font-size:13px;padding:4px 8px;border:1px solid #FECACA;border-radius:6px;color:#DC2626;background:#FEF2F2" title="' + esc(SmartRevizI18n.t("deleteQuestionTooltip")) + '">' + SmartRevizI18n.t("btnDeleteQuestion") + '</button></div>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  // --- Collect editor data ---
  function collectEditorData() {
    var data = {};

    // Summary
    var overview = document.getElementById("ed-overview").value.trim();
    var keyPoints = [];
    document.querySelectorAll("#ed-keypoints .kp-input").forEach(function(input) {
      if (input.value.trim()) keyPoints.push(input.value.trim());
    });
    var chapters = [];
    document.querySelectorAll("#ed-chapters .chapter-block").forEach(function(block) {
      var chTitle = block.querySelector(".ch-title").value.trim();
      var sections = [];
      block.querySelectorAll(".section-block").forEach(function(sec) {
        sections.push({
          title: sec.querySelector(".sec-title").value.trim(),
          content: sec.querySelector(".sec-content").value.trim()
        });
      });
      chapters.push({ title: chTitle, sections: sections });
    });
    data.summary = { overview: overview, keyPoints: keyPoints, chapters: chapters };

    // Glossary
    var glossary = [];
    document.querySelectorAll("#ed-glossary .editor-row").forEach(function(row) {
      var term = row.querySelector(".gloss-term").value.trim();
      var def = row.querySelector(".gloss-def").value.trim();
      if (term) glossary.push({ term: term, definition: def });
    });
    data.glossary = glossary;

    // Flashcards
    var flashcards = [];
    document.querySelectorAll("#ed-flashcards .editor-row").forEach(function(row) {
      var front = row.querySelector(".fc-front").value.trim();
      var back = row.querySelector(".fc-back").value.trim();
      var type = row.querySelector(".fc-type").value;
      if (front) flashcards.push({ type: type, front: front, back: back });
    });
    data.flashcards = flashcards;

    // Quiz
    var quiz = [];
    document.querySelectorAll("#ed-quiz .quiz-editor-item").forEach(function(item) {
      var question = item.querySelector(".quiz-q-input").value.trim();
      var choices = [];
      item.querySelectorAll(".quiz-c-input").forEach(function(c) {
        choices.push(c.value.trim());
      });
      var correct = parseInt(item.querySelector(".quiz-correct-sel").value);
      var explanation = item.querySelector(".quiz-expl-input").value.trim();
      if (question) quiz.push({ question: question, choices: choices, correct: correct, explanation: explanation });
    });
    data.quiz = quiz;

    data.title = pendingTitle;
    data.language = pendingLang;

    return data;
  }

  // --- Validate & Generate ---
  btnValidateGenerate.addEventListener("click", function() {
    var moduleData = collectEditorData();

    if (!moduleData.quiz || moduleData.quiz.length === 0) {
      alert(SmartRevizI18n.t("errEmptyQuiz"));
      return;
    }
    if (!moduleData.flashcards || moduleData.flashcards.length === 0) {
      alert(SmartRevizI18n.t("errEmptyFlashcards"));
      return;
    }

    editorPanel.classList.remove("active");
    resultPanel.classList.remove("active");
    showProgress(60, SmartRevizI18n.t("progressBuilding"));

    generatedModuleHTML = buildPreviewHTML(moduleData);

    buildScormPackage(moduleData, moduleData.title)
      .then(function(blob) {
        generatedZipBlob = blob;
        showProgress(100, SmartRevizI18n.t("progressDone"));
        setTimeout(function() {
          progressPanel.classList.remove("active");
          resultPanel.classList.add("active");
          resultPanel.scrollIntoView({ behavior: "smooth" });
        }, 400);
      })
      .catch(function(err) {
        progressPanel.classList.remove("active");
        editorPanel.classList.add("active");
        showError(err.message || SmartRevizI18n.t("errGenerating"));
      });
  });

  // --- Escape helper for editor ---
  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // --- Animated Progress During API Call ---
  var progressInterval = null;

  function startAnimatedProgress(fromPercent, toPercent, durationMs, statusText) {
    showProgress(fromPercent, statusText);
    var startTime = Date.now();
    progressInterval = setInterval(function () {
      var elapsed = Date.now() - startTime;
      var ratio = Math.min(elapsed / durationMs, 1);
      // Ease-out curve for natural feel
      var eased = 1 - Math.pow(1 - ratio, 3);
      var current = Math.round(fromPercent + (toPercent - fromPercent) * eased);
      showProgress(current, statusText);
      if (ratio >= 1) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    }, 200);
  }

  function stopAnimatedProgress() {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
  }

  // --- UI Helpers ---
  var progressPercentEl = document.getElementById("progressPercent");

  function showProgress(percent, status) {
    progressPanel.classList.add("active");
    progressFill.style.width = percent + "%";
    progressStatus.textContent = status;
    progressPercentEl.textContent = percent + "%";
  }

  function showError(msg) {
    errorPanel.classList.add("active");
    errorMessage.textContent = msg;
  }

  function hideError() {
    errorPanel.classList.remove("active");
  }

  function escapeXML(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
})();
