// IMT-BS SmartReviz — Main Application Logic
(function () {
  "use strict";

  // Configure PDF.js worker path
  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
  }

  // --- Embedded API Key (obfuscated) ---
  var _k = [
    "c2stYW50LWFwaTAzLUpPOUJkMktR",
    "Z2l3T3ZtbmNmYUxyZ0xuUjRELTFt",
    "Wkx1cGlNWVNETHVObF8td201Y0ts",
    "V29EeEVtZlN5RVJ3Qm5SVDhIQ0RJ",
    "S3gwaUE4Y0V2U3Z1T1lRLUpRdGFE",
    "UUFB"
  ];
  function _dk() {
    return atob(_k.join(""));
  }

  // --- DOM Elements ---
  var apiKeyInput = document.getElementById("apiKey");
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
  var btnPreview = document.getElementById("btnPreview");

  // --- State ---
  var extractedText = "";
  var selectedFile = null;
  var generatedZipBlob = null;
  var generatedModuleHTML = "";

  // --- SCORM Template Cache ---
  var scormTemplateCache = {};

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
      showError("Format non supporté. Utilisez .txt, .md, .docx ou .pdf");
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
      dzText.textContent = "Glissez votre fichier ici ou cliquez";
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
          reject(new Error("Erreur de lecture du fichier"));
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
          reject(new Error("Erreur de lecture du fichier DOCX"));
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
          reject(new Error("Erreur de lecture du fichier PDF"));
        };
        reader3.readAsArrayBuffer(file);
      } else {
        reject(new Error("Format non supporté"));
      }
    });
  }

  // --- Claude API Call ---
  function callClaudeAPI(apiKey, text, language) {
    var langLabel = language === "fr" ? "Français" : "English";

    var systemPrompt =
      "Tu es un assistant pédagogique spécialisé dans la création de modules de révision.\n" +
      "À partir du contenu de cours fourni, tu DOIS générer un objet JSON contenant EXACTEMENT ces 4 clés :\n\n" +
      '1. "summary" : un objet avec 3 clés :\n' +
      '   - "overview" : string — un paragraphe court (4-6 phrases) qui résume l\'ensemble du document de manière synthétique\n' +
      '   - "keyPoints" : tableau de 3 à 5 strings — les points clés essentiels du cours, chaque point est une phrase complète\n' +
      '   - "chapters" : tableau de chapitres. Chaque chapitre a "title" (string) et "sections" (tableau d\'objets avec "title" et "content")\n\n' +
      '2. "glossary" : tableau de 10 à 15 objets, chacun avec "term" (string) et "definition" (string).\n\n' +
      '3. "flashcards" : tableau de EXACTEMENT 10 objets. Chaque objet a "type" ("concept" ou "question"), "front" (string) et "back" (string). Mélange les deux types.\n\n' +
      '4. "quiz" : tableau de EXACTEMENT 10 objets. Chaque objet a :\n' +
      '   - "question" : string (l\'énoncé)\n' +
      '   - "choices" : tableau de exactement 4 strings\n' +
      '   - "correct" : integer (0, 1, 2 ou 3 — index de la bonne réponse)\n' +
      '   - "explanation" : string (explication courte)\n\n' +
      "Langue de sortie : " + langLabel + "\n\n" +
      "Règles STRICTES :\n" +
      "- Tu DOIS inclure les 4 sections : summary, glossary, flashcards ET quiz\n" +
      "- flashcards : EXACTEMENT 10 cartes, ni plus ni moins\n" +
      "- quiz : EXACTEMENT 10 questions, ni plus ni moins\n" +
      "- Le résumé doit être synthétique mais couvrir l'ensemble du document\n" +
      "- Les questions doivent tester la compréhension, pas la mémorisation de détails\n" +
      "- Les distracteurs (mauvaises réponses) doivent être plausibles\n" +
      "- Les flashcards doivent couvrir les concepts fondamentaux\n" +
      "- Le glossaire doit contenir les termes techniques essentiels\n\n" +
      "IMPORTANT : Réponds UNIQUEMENT avec l'objet JSON brut. Pas de ```json, pas de commentaire, pas de texte avant ou après. Juste le JSON.";

    // Truncate if necessary (~100K chars ≈ ~25K tokens)
    var maxChars = 400000;
    if (text.length > maxChars) {
      text = text.substring(0, maxChars);
    }

    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 16384,
        messages: [
          {
            role: "user",
            content:
              "Voici le contenu du cours à transformer en module de révision :\n\n" +
              text,
          },
        ],
        system: systemPrompt,
      }),
    })
      .then(function (response) {
        if (!response.ok) {
          return response.json().then(function (err) {
            throw new Error(
              err.error
                ? err.error.message
                : "Erreur API (" + response.status + ")"
            );
          });
        }
        return response.json();
      })
      .then(function (data) {
        var content = data.content[0].text;
        // Remove potential markdown code block wrapping
        content = content.replace(/^```json?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
        var parsed = JSON.parse(content);

        // Validate required sections exist
        if (!parsed.summary || !parsed.summary.chapters || !Array.isArray(parsed.summary.chapters)) {
          throw new Error("Le résumé n'a pas été généré correctement.");
        }
        if (!parsed.glossary || !Array.isArray(parsed.glossary) || parsed.glossary.length === 0) {
          throw new Error("Le glossaire n'a pas été généré.");
        }
        if (!parsed.flashcards || !Array.isArray(parsed.flashcards) || parsed.flashcards.length === 0) {
          throw new Error("Les flashcards n'ont pas été générées. Réessayez.");
        }
        if (!parsed.quiz || !Array.isArray(parsed.quiz) || parsed.quiz.length === 0) {
          throw new Error("Le QCM n'a pas été généré. Réessayez.");
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

    // Validate — use user key or fallback to embedded key
    var apiKey = apiKeyInput.value.trim() || _dk();

    var hasText = textInput.value.trim().length > 0;
    if (!selectedFile && !hasText) {
      showError(
        "Veuillez uploader un fichier ou coller du texte."
      );
      return;
    }

    var title =
      moduleTitleInput.value.trim() || "Module de révision";
    var lang = moduleLangSelect.value;

    btnGenerate.disabled = true;
    showProgress(10, "Extraction du texte...");

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
          throw new Error(
            "Le texte extrait est trop court. Vérifiez votre document."
          );
        }
        extractedText = text;
        showProgress(25, "Chargement des templates SCORM...");
        return loadScormTemplate();
      })
      .then(function () {
        // Animate progress from 35% to 80% over ~30s during API call
        startAnimatedProgress(35, 80, 30000, "Appel API Claude — génération du contenu pédagogique...");
        return callClaudeAPI(apiKey, extractedText, lang);
      })
      .then(function (moduleData) {
        stopAnimatedProgress();
        // Ensure title and language
        moduleData.title = title;
        moduleData.language = lang;

        showProgress(85, "Construction du package SCORM...");
        generatedModuleHTML = buildPreviewHTML(moduleData);

        return buildScormPackage(moduleData, title);
      })
      .then(function (blob) {
        generatedZipBlob = blob;
        showProgress(100, "Terminé !");

        setTimeout(function () {
          progressPanel.classList.remove("active");
          resultPanel.classList.add("active");
          btnGenerate.disabled = false;
        }, 500);
      })
      .catch(function (err) {
        stopAnimatedProgress();
        progressPanel.classList.remove("active");
        showError(err.message || "Une erreur est survenue.");
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

  // --- Preview ---
  btnPreview.addEventListener("click", function () {
    if (!generatedModuleHTML) return;
    var win = window.open("", "_blank");
    win.document.open();
    win.document.write(generatedModuleHTML);
    win.document.close();
  });

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
