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

  // --- LLM API Call (via proxy Cloudflare Worker → moteur souverain ILAAS) ---
  // Réassemble un flux SSE (Server-Sent Events) en une seule chaîne de texte.
  // Le proxy relaie le flux du modèle tel quel plutôt que de le recoller
  // lui-même : le plan Cloudflare Workers gratuit plafonne à 10 ms de CPU, très
  // en deçà de ce que coûte le parsing de plusieurs milliers de fragments.
  // Côté navigateur, ce plafond n'existe pas. Voir proxy/worker.js.
  function readSSEStream(response, onProgress) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    var text = "";
    var finishReason = null;

    function handleBlock(block) {
      var lines = block.split("\n");
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("data:") !== 0) continue;
        var payload = lines[i].slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        var chunk;
        try {
          chunk = JSON.parse(payload);
        } catch (e) {
          continue; // fragment illisible : on l'ignore plutôt que tout perdre
        }
        var choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        var piece = choice.delta && choice.delta.content;
        if (typeof piece === "string") text += piece;
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }

    // Les événements SSE sont séparés par une ligne vide ; on ne traite que les
    // blocs complets et on garde le reliquat pour le tour suivant.
    function absorb(part) {
      buffer += part;
      var blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      for (var i = 0; i < blocks.length; i++) handleBlock(blocks[i]);
    }

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          absorb(decoder.decode());
          // Dernier événement non suivi d'une ligne vide : sans ce rattrapage,
          // la fin de la génération serait perdue.
          if (buffer) {
            handleBlock(buffer);
            buffer = "";
          }
          return { text: text, finishReason: finishReason };
        }
        absorb(decoder.decode(r.value, { stream: true }));
        if (onProgress) onProgress(text.length);
        return pump();
      });
    }

    return pump();
  }

  var ALL_SECTIONS = ["summary", "glossary", "flashcards", "quiz"];

  // Chaque section est décrite isolément afin de pouvoir n'en redemander qu'une
  // partie. Le modèle omet parfois une section entière d'une génération complète ;
  // la redemander seule produit une sortie bien plus courte, donc nettement plus
  // fiable, et en quelques secondes au lieu de rejouer les 35 s de génération.
  var SECTION_SPECS = {
    summary:
      '"summary" : un objet avec 3 clés :\n' +
      '   - "overview" : string — un paragraphe de synthèse complet (6 à 8 phrases) couvrant l\'ensemble du document : contexte, enjeux principaux, structure du cours et apports clés. Rédigé en prose fluide, sans liste ni bullet point.\n' +
      '   - "keyPoints" : tableau de 4 à 6 strings — les points clés essentiels du cours. Chaque point est une phrase complète et autonome (sujet + verbe + complément), qui apporte une information substantielle, pas un simple titre de rubrique.\n' +
      '   - "chapters" : tableau de 4 à 8 chapitres thématiques couvrant l\'ensemble du document. Chaque chapitre a :\n' +
      '       * "title" : string — titre thématique clair du chapitre\n' +
      '       * "sections" : tableau de 1 à 3 objets, chacun avec :\n' +
      '           - "title" : string — sous-titre de la section\n' +
      '           - "content" : string — paragraphe rédigé de 4 à 6 phrases complètes expliquant en détail le contenu de cette section. Ce contenu doit être informatif, précis, et rédigé en prose continue (pas de listes, pas de mots-clés isolés). Il ne doit contenir QUE des informations présentes dans le document ; il mentionne les faits, chiffres, noms ou exemples du document lorsqu\'il y en a, sans en ajouter.\n' +
      '           - "source" : string — extrait COPIÉ MOT POUR MOT du document (5 à 25 mots) sur lequel s\'appuie cette section.',
    glossary:
      '"glossary" : tableau de 10 à 15 objets (moins si le document ne contient pas assez de termes définis ou expliqués), chacun avec "term" (string), "definition" (string — définition en 2-3 phrases, fondée uniquement sur ce que dit le document) et "source" (string — extrait COPIÉ MOT POUR MOT du document, 5 à 25 mots, qui définit ou explique ce terme).',
    flashcards:
      '"flashcards" : tableau de 10 objets au plus (moins si le document ne permet pas d\'en tirer 10 de fondées). Chaque objet a "type" ("concept" ou "question"), "front" (string), "back" (string — réponse en 2-3 phrases, fondée uniquement sur le document) et "source" (string — extrait COPIÉ MOT POUR MOT du document, 5 à 25 mots, qui contient la réponse). Mélange les deux types.',
    quiz:
      '"quiz" : tableau de 10 objets au plus (moins si le document ne permet pas d\'en tirer 10 de fondées). Chaque objet a :\n' +
      '   - "question" : string (l\'énoncé)\n' +
      '   - "choices" : tableau de exactement 4 strings\n' +
      '   - "correct" : integer (0, 1, 2 ou 3 — index de la bonne réponse)\n' +
      '   - "explanation" : string (explication de 2-3 phrases justifiant la bonne réponse, avec ce que dit le document)\n' +
      '   - "source" : string — extrait COPIÉ MOT POUR MOT du document (5 à 25 mots) qui établit la bonne réponse',
  };

  var SECTION_RULES = {
    summary: [
      "- summary.chapters : jusqu'à 8 chapitres (4 à 8 si le document est assez riche, moins s'il est court). Ils doivent couvrir " +
        "l'intégralité du document, du début à la fin — pas seulement ses premières pages — sans rien ajouter qui n'y figure pas.",
      "- INTERDIT dans le résumé : listes à puces, tirets, mots-clés isolés, phrases incomplètes. Uniquement de la prose rédigée.",
      "- Chaque section du résumé reprend des informations précises du document (noms, dates, chiffres, exemples) lorsqu'il en contient. Ne complète JAMAIS avec des connaissances extérieures pour rendre une section plus longue.",
    ],
    glossary: [
      "- glossary : de 10 à 15 termes si le document le permet, JAMAIS plus de 15. Un terme absent du document n'a pas sa place, même s'il est courant dans le domaine.",
      "- Chaque définition reprend celle du document ou la paraphrase fidèlement ; si le document ne définit pas un terme, ne le mets pas dans le glossaire",
    ],
    flashcards: [
      "- flashcards : 10 cartes au plus, JAMAIS plus de 10 ; moins si le document est court",
      "- Les flashcards portent sur les concepts fondamentaux du document, et chaque réponse doit se retrouver dans le document",
    ],
    quiz: [
      "- quiz : 10 questions au plus, JAMAIS plus de 10 ; moins si le document est court",
      "- Les questions doivent tester la compréhension, pas la mémorisation de détails, et leur bonne réponse doit être établie par le document (jamais par tes connaissances générales)",
      "- Les distracteurs (mauvaises réponses) doivent être plausibles mais faux au regard du document",
    ],
  };

  function buildSystemPrompt(language, sections, nbCars) {
    var langLabel = language === "fr" ? "Français" : "English";
    var partiel = sections.length < ALL_SECTIONS.length;

    var prompt =
      "Tu es un assistant pédagogique spécialisé dans la création de modules de révision.\n";
    prompt += partiel
      ? "Une première génération a échoué sur une partie du module. À partir du contenu de " +
        "cours fourni, tu DOIS produire un objet JSON contenant UNIQUEMENT " +
        (sections.length > 1 ? "ces " + sections.length + " clés" : "cette clé") +
        " :\n\n"
      : "À partir du contenu de cours fourni, tu DOIS générer un objet JSON contenant EXACTEMENT ces 4 clés :\n\n";

    for (var i = 0; i < sections.length; i++) {
      prompt += i + 1 + ". " + SECTION_SPECS[sections[i]] + "\n\n";
    }

    prompt += "Langue de sortie : " + langLabel + "\n\nRègles STRICTES :\n";
    prompt +=
      "- FIDÉLITÉ AU DOCUMENT (règle absolue, prioritaire sur toutes les autres, y compris sur les nombres d'éléments) : " +
      "le document fourni entre <document> et </document> est ta SEULE source. N'utilise AUCUNE connaissance extérieure, " +
      "n'ajoute aucun fait, chiffre, nom, date, exemple, définition ou nuance qui n'y figure pas, n'extrapole pas, " +
      "ne généralise pas au-delà de ce qu'il dit. Si le document est court ou ne couvre pas un point, produis MOINS " +
      "d'éléments plutôt que d'en inventer : un module court mais fidèle vaut mieux qu'un module complet mais enrichi.\n" +
      "- Les champs \"source\" sont des citations littérales, copiées caractère pour caractère depuis le document " +
      "(même orthographe, même ponctuation), sans reformulation ni traduction. Un élément dont tu ne peux pas citer le passage est un élément à ne pas produire.\n";
    prompt +=
      "- Tu DOIS inclure " +
      (partiel ? "la totalité des clés demandées ci-dessus" : "les 4 sections : summary, glossary, flashcards ET quiz") +
      "\n";
    prompt +=
      "- TAILLE DE CE DOCUMENT : environ " + nbCars + " caractères. Pour lui, produis AU PLUS : " +
      sections
        .map(function (nom) {
          var n = plafondPour(nom, nbCars);
          return nom === "summary" ? n + " chapitre(s)" : n + " " + { glossary: "terme(s) de glossaire", flashcards: "flashcard(s)", quiz: "question(s) de QCM" }[nom];
        })
        .join(", ") +
      ". Ces maximums REMPLACENT les nombres cités plus haut dès qu'ils sont plus petits ; ne les atteins que si le document contient de quoi les fonder.\n";
    for (var j = 0; j < sections.length; j++) {
      var regles = SECTION_RULES[sections[j]];
      for (var k = 0; k < regles.length; k++) prompt += regles[k] + "\n";
    }
    prompt +=
      "- Compte tes éléments avant de répondre. Dépasser les maximums rend la réponse " +
      "inutilisable : la sortie est coupée avant la fin et tout le travail est perdu.\n" +
      "- Reste concis dans les définitions et explications : va à l'essentiel plutôt " +
      "que de multiplier les reformulations.\n\n" +
      "IMPORTANT : Réponds UNIQUEMENT avec l'objet JSON brut. Pas de ```json, pas de " +
      "commentaire, pas de texte avant ou après. Juste le JSON.";

    return prompt;
  }

  // Envoie une requête au relais et renvoie le texte brut de la réponse du modèle
  // (flux SSE recollé, ou erreur du relais traduite pour l'enseignant).
  function appelerProxy(corps) {
    return fetch(PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(corps),
    })
      .then(function (response) {
        var contentType = response.headers.get("Content-Type") || "";

        // Cas nominal : le proxy relaie le flux du modèle, on le recolle ici.
        if (response.ok && contentType.indexOf("text/event-stream") !== -1) {
          return readSSEStream(response).then(function (result) {
            if (!result.text) {
              var vide = new Error(SmartRevizI18n.t("errBadJSON"));
              vide.retryable = true;
              throw vide;
            }
            // Génération coupée au plafond de tokens : le JSON s'arrête en plein
            // milieu. Une relance a de bonnes chances d'être plus compacte.
            if (result.finishReason === "length") {
              var coupe = new Error(SmartRevizI18n.t("errBadJSON"));
              coupe.retryable = true;
              throw coupe;
            }
            return result.text;
          });
        }

        // Sinon : le proxy a renvoyé une erreur (ou une réponse non-streamée).
        return response.text().then(function (body) {
          var data;
          try {
            data = JSON.parse(body);
          } catch (e) {
            if (response.status === 524 || response.status === 504) {
              throw new Error(SmartRevizI18n.t("errTimeout"));
            }
            // Cloudflare renvoie une page HTML quand le Worker dépasse ses
            // limites : inutile de l'afficher telle quelle à l'enseignant.
            if (/worker exceeded|<!DOCTYPE|<html/i.test(body)) {
              var surcharge = new Error(SmartRevizI18n.t("errTimeout"));
              surcharge.retryable = true;
              throw surcharge;
            }
            throw new Error("API Error (" + response.status + "): " + body.substring(0, 200));
          }
          if (!response.ok || data.error) {
            var msg = data.error ? (data.error.message || data.error) : "API Error (" + response.status + ")";
            // « Time-out » avec un tiret : c'est la formulation de la passerelle
            // ILAAS, que /timeout/ seul ne reconnaissait pas — l'enseignant se
            // retrouvait alors avec du HTML brut à l'écran.
            if (msg === "TIMEOUT" || /time-?out|timed out|gateway/i.test(msg)) {
              throw new Error(SmartRevizI18n.t("errTimeout"));
            }
            // Réponse coupée au plafond de tokens : une relance a de bonnes
            // chances de produire une sortie plus compacte.
            if (/^TRUNCATED/.test(msg)) {
              var truncated = new Error(SmartRevizI18n.t("errBadJSON"));
              truncated.retryable = true;
              throw truncated;
            }
            throw new Error(msg);
          }
          return data.content[0].text || "";
        });
      });
  }

  // Décode la réponse JSON du modèle (avec repêchage si elle est entourée de texte).
  function decoderJSON(content) {
    content = content.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
    try {
      return JSON.parse(content);
    } catch (e) {
      var first = content.indexOf("{");
      var last = content.lastIndexOf("}");
      if (first !== -1 && last > first) {
        try {
          return JSON.parse(content.slice(first, last + 1));
        } catch (e2) {
          /* retombe sur l'erreur ci-dessous */
        }
      }
    }
    var badJson = new Error(SmartRevizI18n.t("errBadJSON"));
    badJson.retryable = true;
    throw badJson;
  }

  function callLLMAPI(text, language, sections) {
    sections = sections || ALL_SECTIONS;
    var systemPrompt = null; // construit après la troncature, avec la taille réelle du texte

    // Truncate if necessary (~60K chars ≈ ~15 pages, fits within Cloudflare 100s timeout)
    var maxChars = 60000;
    if (text.length > maxChars) {
      console.warn("SmartReviz — Text truncated from " + text.length + " to " + maxChars + " chars");
      text = text.substring(0, maxChars);
    }
    systemPrompt = buildSystemPrompt(language, sections, text.length);

    return appelerProxy({
      // 16384 et non 8192 : sur un document volumineux la génération atteignait
      // le plafond, coupant le JSON en plein milieu (donc inexploitable). Le
      // modèle s'arrête de lui-même vers 7 500-8 000 tokens : cette marge ne
      // coûte rien, elle évite seulement la troncature.
      max_tokens: 16384,
      // 0.2 et non 0.4 : on cherche la fidélité au document, pas la variété.
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content:
            (language === "fr"
              ? "Voici le contenu du cours à transformer en module de révision :\n\n"
              : "Here is the course content to transform into a revision module:\n\n") +
            "<document>\n" + text + "\n</document>",
        },
      ],
      system: systemPrompt,
    })
      .then(function (content) {
        var parsed = decoderJSON(content);

        normaliserModule(parsed, text.length);
        verifierAncrage(parsed, text);

        // Une réponse partielle n'est plus rejetée : on garde les sections
        // valides, et callLLMWithRetry se chargera de redemander le reste.
        var obtenues = sections.filter(function (nom) {
          return sectionValide(parsed, nom);
        });
        if (obtenues.length === 0) {
          var rien = new Error(SmartRevizI18n.t(ERREUR_SECTION[sections[0]] || "errBadJSON"));
          rien.retryable = true;
          throw rien;
        }
        console.log("SmartReviz — sections reçues :", obtenues.join(", "));
        return parsed;
      });
  }

  var ERREUR_SECTION = {
    summary: "errSummary",
    glossary: "errGlossary",
    flashcards: "errFlashcards",
    quiz: "errQuiz",
  };

  function sectionValide(module, nom) {
    if (!module) return false;
    if (nom === "summary") {
      return !!(
        module.summary &&
        Array.isArray(module.summary.chapters) &&
        module.summary.chapters.length > 0
      );
    }
    return Array.isArray(module[nom]) && module[nom].length > 0;
  }

  // Seuils de contenu jugé suffisant. Une section valide mais trop maigre (le
  // modèle a produit 2 chapitres pour un cours de 15 pages) est redemandée une
  // fois, sans jamais faire échouer la génération pour autant : mieux vaut un
  // résumé court que pas de module du tout.
  var SEUILS_SUFFISANCE = { summary: 4, glossary: 10, flashcards: 8, quiz: 8 };

  // Un cours court ne peut pas fonder autant d'éléments qu'un long : lui en
  // demander 10 de chaque pousse le modèle à compléter avec ses connaissances
  // (constaté : 10 termes, 10 flashcards et 10 questions pour six phrases). Les
  // maximums et les seuils descendent donc avec la taille du document.
  var PLAFONDS_ABSOLUS = { summary: 8, glossary: 15, flashcards: 10, quiz: 10 };
  var CARS_PAR_ELEMENT = { summary: 1500, glossary: 400, flashcards: 500, quiz: 500 };
  var PLANCHERS = { summary: 1, glossary: 3, flashcards: 3, quiz: 3 };

  function plafondPour(nom, nbCars) {
    var adapte = Math.floor(nbCars / CARS_PAR_ELEMENT[nom]);
    return Math.min(PLAFONDS_ABSOLUS[nom], Math.max(PLANCHERS[nom], adapte));
  }

  function seuilPour(nom, nbCars) {
    return Math.min(SEUILS_SUFFISANCE[nom], plafondPour(nom, nbCars));
  }

  function tailleSection(module, nom) {
    if (!sectionValide(module, nom)) return 0;
    return nom === "summary" ? module.summary.chapters.length : module[nom].length;
  }

  function sectionSuffisante(module, nom, nbCars) {
    if (!sectionValide(module, nom)) return false;
    return tailleSection(module, nom) >= seuilPour(nom, nbCars);
  }

  // --- Ancrage dans le document ---
  // Chaque élément généré cite l'extrait du document qui le fonde (champ
  // "source"). On vérifie ici que cet extrait figure bien dans le texte déposé :
  // un élément dont la citation est introuvable vient des connaissances du
  // modèle, pas du cours, et il est écarté. Comparaison tolérante à la casse,
  // aux accents, à la ponctuation et aux espaces (les extraits PDF/Word en
  // contiennent de très irréguliers).
  function normaliserPourComparaison(str) {
    return String(str || "")
      .toLowerCase()
      .normalize("NFKD") // accents, mais aussi CO₂ → co2 et les ligatures « ﬁ » des PDF
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function ensembleTrigrammes(mots) {
    var set = {};
    for (var i = 0; i + 3 <= mots.length; i++) set[mots[i] + " " + mots[i + 1] + " " + mots[i + 2]] = true;
    return set;
  }

  // Retourne une fonction « cette citation figure-t-elle dans le document ? ».
  function creerVerificateurCitation(texteSource) {
    var corps = " " + normaliserPourComparaison(texteSource) + " ";
    var trigrammes = ensembleTrigrammes(corps.trim().split(" "));

    function fragmentPresent(fragment) {
      var norm = normaliserPourComparaison(fragment);
      var mots = norm ? norm.split(" ") : [];
      if (mots.length < 3) return false; // trop court pour prouver quoi que ce soit
      if (corps.indexOf(" " + norm + " ") !== -1) return true;
      // Citation légèrement altérée (un mot changé) : 80 % de ses suites de
      // trois mots doivent exister telles quelles dans le document.
      var tri = Object.keys(ensembleTrigrammes(mots));
      if (!tri.length) return false;
      var trouves = tri.filter(function (t) { return trigrammes[t]; }).length;
      return trouves / tri.length >= 0.8;
    }

    return function (citation) {
      if (typeof citation !== "string") return false;
      // « début ... fin » : chaque morceau doit exister séparément.
      var morceaux = citation.split(/\.{3}|…|\[\.\.\.\]|\[…\]/).filter(function (m) {
        return m.trim().length > 0;
      });
      if (!morceaux.length) return false;
      return morceaux.every(function (m) {
        return normaliserPourComparaison(m).split(" ").length < 3 || fragmentPresent(m);
      }) && morceaux.some(function (m) { return fragmentPresent(m); });
    };
  }

  function verifierAncrage(module, texteSource) {
    var citationValide = creerVerificateurCitation(texteSource);

    function filtrer(liste, label) {
      if (!Array.isArray(liste)) return liste;
      var gardes = liste.filter(function (el) { return el && citationValide(el.source); });
      if (gardes.length !== liste.length) {
        console.warn(
          "SmartReviz — " + (liste.length - gardes.length) + " " + label +
            " écarté(s) : extrait source introuvable dans le document"
        );
      }
      return gardes;
    }

    module.glossary = filtrer(module.glossary, "terme(s) de glossaire");
    module.flashcards = filtrer(module.flashcards, "flashcard(s)");
    module.quiz = filtrer(module.quiz, "question(s) QCM");

    if (module.summary && Array.isArray(module.summary.chapters)) {
      var ecartees = 0;
      module.summary.chapters = module.summary.chapters
        .map(function (ch) {
          var sections = (ch.sections || []).filter(function (sec) {
            var ok = sec && citationValide(sec.source);
            if (!ok) ecartees++;
            return ok;
          });
          return { title: ch.title, sections: sections };
        })
        .filter(function (ch) { return ch.sections.length > 0; });
      if (ecartees) {
        console.warn("SmartReviz — " + ecartees + " section(s) de résumé écartée(s) : extrait source introuvable");
      }
    }
  }

  // --- Audit de fidélité ---
  // Les citations vérifiées ci-dessus prouvent qu'un passage existe, pas que
  // l'élément ne dit rien de plus que ce passage. Constaté le 15/10/2026 : un
  // cours de six phrases donnait « RuBisCO, l'enzyme la plus abondante sur
  // Terre », « ribulose-1,5-bisphosphate », « thylakoïdes »... absents du
  // document. L'audit travaille donc phrase par phrase et ne fait que RETIRER
  // (un modèle qui « corrige » réintroduit d'autres faits extérieurs) :
  //   1. contrôle déterministe : une phrase qui contient un terme technique
  //      (mot composé à chiffre, sigle, formule) introuvable dans le document
  //      est retirée ;
  //   2. recherche de passages (le « RAG » de l'outil) : le code retrouve, dans le
  //      document, les 4 passages les plus proches de chaque phrase ; le modèle,
  //      à température 0, ne fait que désigner ceux qui établissent TOUT ce que
  //      dit la phrase. Le code vérifie que les passages désignés existent et
  //      recoupent la phrase ; sans passage valable, la phrase est retirée (ce
  //      qui est douteux est écarté). Faire recopier des citations au modèle a
  //      été essayé : il recopie la phrase générée au lieu du document.
  // Un élément dont il ne reste rien (ou dont le terme / la bonne réponse est
  // retiré) est écarté.

  var NB_ESSAIS_AUDIT = 2;

  function decouperPhrases(texte) {
    return (String(texte || "").match(/[\s\S]+?[.!?…](?=\s|$)|[\s\S]+$/g) || [])
      .map(function (p) { return p.trim(); })
      .filter(Boolean);
  }

  var TRAITS_UNION_COURANTS = /^(peut-être|c'est-à-dire|ci-dessus|ci-dessous|au-dessus|au-dessous|au-delà|vis-à-vis|celui-ci|celle-ci|ceux-ci|celles-ci|celui-là|celle-là)$/i;

  function creerAnalyseurSource(texteSource) {
    var corps = " " + normaliserPourComparaison(texteSource) + " ";

    function motsCandidats(phrase) {
      return phrase
        .split(/[\s()«»"“”;:!?\/'’]+/)
        .map(function (t) { return t.replace(/^[.,'’]+|[.,'’]+$/g, ""); })
        .filter(Boolean);
    }

    // Terme composé « technique » : chaque morceau compte au moins 3 caractères
    // (écarte « qu'est-ce », « sert-il », « a-t-on ») et il n'est pas une
    // locution courante.
    function composeTechnique(t) {
      if (t.indexOf("-") === -1 || TRAITS_UNION_COURANTS.test(t)) return false;
      return t.split("-").every(function (m) { return m.replace(/[^A-Za-zÀ-ÿ0-9]/g, "").length >= 3; });
    }

    return {
      // Termes techniques : mot composé, mélange lettres + chiffres, sigle
      // (2 majuscules ou plus) ou majuscule interne (RuBisCO). Les chiffres
      // seuls sont ignorés : « 3 » et « trois » ne se comparent pas.
      termesTechniquesAbsents: function (phrase) {
        return motsCandidats(phrase).filter(function (t) {
          if (!/[A-Za-zÀ-ÿ]/.test(t)) return false;
          var technique = composeTechnique(t) || /\d/.test(t) || /[A-ZÀ-Þ]{2,}/.test(t) || /[a-zà-ÿ][A-ZÀ-Þ]/.test(t);
          if (!technique) return false;
          var norm = normaliserPourComparaison(t);
          // Par préfixe : « API » est présent si le document dit « APIs ».
          return norm && corps.indexOf(" " + norm) === -1;
        });
      },
      // Un terme de glossaire doit figurer dans le document : au moins 60 % de ses
      // mots (3 lettres et plus) y apparaissent, au singulier ou au pluriel.
      termePresent: function (terme) {
        var mots = normaliserPourComparaison(terme.replace(/\(.*?\)/g, " ")).split(" ").filter(function (m) { return m.length >= 3; });
        if (!mots.length) return true;
        var trouves = mots.filter(function (m) { return corps.indexOf(" " + m) !== -1; }).length;
        return trouves / mots.length >= 0.6;
      },
    };
  }

  // Racines (5 premières lettres) des mots d'au moins 5 lettres : sert à vérifier
  // qu'une preuve recoupe bien la phrase qu'elle prétend fonder.
  function racinesDe(texte) {
    var r = {};
    normaliserPourComparaison(texte).split(" ").forEach(function (m) { if (m.length >= 5) r[m.slice(0, 5)] = true; });
    return r;
  }

  function preuveRecoupe(phrase, preuve) {
    var rp = Object.keys(racinesDe(phrase));
    if (!rp.length) return true;
    var rq = racinesDe(preuve);
    var communs = rp.filter(function (m) { return rq[m]; }).length;
    return communs / rp.length >= 0.3;
  }

  // Une phrase composée (« X, un compartiment distinct des thylakoïdes où... »)
  // peut être fondée pour sa première moitié seulement : constaté, la moitié
  // ajoutée passait avec le reste. On juge donc aussi chaque proposition introduite
  // par une virgule et un mot de liaison, puis on recolle ce qui est retenu.
  var COUPURE_PROPOSITION = /(?=,\s+(?:un|une|où|qui|dont|car|ou|mais|tandis que|alors que|ce qui|ce que|permettant|permettent|illustrant|soulignant|assurant|garantissant|formant|constituant|notamment|ainsi|puis|en raison|grâce|afin|pour)\b)/i;

  function decouperPropositions(texte) {
    var pieces = [];
    decouperPhrases(texte).forEach(function (ph, numPhrase) {
      var morceaux = ph.split(COUPURE_PROPOSITION);
      // Les morceaux trop courts sont rattachés au précédent.
      var fusion = [];
      morceaux.forEach(function (m) {
        if (fusion.length && m.replace(/^[,\s]+/, "").length < 15) fusion[fusion.length - 1] += m;
        else fusion.push(m);
      });
      fusion.forEach(function (m) { pieces.push({ texte: m, phrase: numPhrase, complete: ph }); });
    });
    return pieces;
  }

  function reconstruireTexte(pieces) {
    var groupes = [];
    pieces.forEach(function (pc) {
      var g = groupes.length && groupes[groupes.length - 1].phrase === pc.phrase ? groupes[groupes.length - 1] : null;
      if (!g) { g = { phrase: pc.phrase, morceaux: [] }; groupes.push(g); }
      g.morceaux.push(pc.texte);
    });
    return groupes
      .map(function (g) {
        var t = g.morceaux.join("");
        var coupe = /^[\s,;]/.test(t);
        t = t.replace(/^[\s,;]+/, "");
        if (coupe) t = t.charAt(0).toUpperCase() + t.slice(1);
        if (!/[.!?…]$/.test(t)) t = t.replace(/[\s,;:]+$/, "") + ".";
        return t;
      })
      .join(" ");
  }

  // Un « élément » est une unité que l'on peut écarter en bloc (terme, flashcard,
  // question, section, point clé). Ses « en-têtes » (terme, recto, question, bonne
  // réponse) entraînent l'écart de l'élément s'ils sont non fondés ; ses
  // « phrases » (définition, verso, explication, contenu) sont retirées une à une.
  function construireElementsAudit(module) {
    var elements = [];
    function ajouter(id, titre, entetes, texte, ecrire, retirer) {
      elements.push({
        id: id,
        titre: titre,
        entetes: entetes.map(function (e) { return { sid: id + "." + e.nom, texte: e.texte, aProuver: !!e.aProuver, terme: e.terme }; }),
        phrases: decouperPropositions(texte).map(function (pc, k) {
          return { sid: id + "." + (k + 1), texte: pc.texte.replace(/^[\s,;]+/, ""), phrase: pc.phrase, brut: pc.texte, complete: pc.complete };
        }),
        aDuTexte: !!String(texte || "").trim(),
        ecrire: ecrire,
        retirer: retirer,
      });
    }
    var sm = module.summary;
    if (sm) {
      if (sm.overview) ajouter("ov", "résumé : vue d'ensemble", [], sm.overview, function (t) { sm.overview = t; }, function () { sm.overview = ""; });
      (sm.keyPoints || []).forEach(function (kp, i) {
        ajouter("kp" + i, "point clé", [], kp, function (t) { sm.keyPoints[i] = t; }, function () { sm.keyPoints[i] = null; });
      });
      (sm.chapters || []).forEach(function (ch, i) {
        (ch.sections || []).forEach(function (sec, j) {
          ajouter("s" + i + "_" + j, "résumé : section « " + (sec.title || "") + " »", [], sec.content,
            function (t) { sec.content = t; }, function () { ch.sections[j] = null; });
        });
      });
    }
    (module.glossary || []).forEach(function (g, i) {
      ajouter("g" + i, "glossaire", [{ nom: "T", texte: "Terme : " + g.term, terme: g.term }], g.definition,
        function (t) { g.definition = t; }, function () { module.glossary[i] = null; });
    });
    (module.flashcards || []).forEach(function (f, i) {
      ajouter("f" + i, "flashcard", [{ nom: "Q", texte: "Recto : " + f.front }], f.back,
        function (t) { f.back = t; }, function () { module.flashcards[i] = null; });
    });
    (module.quiz || []).forEach(function (q, i) {
      ajouter("q" + i, "QCM", [
        { nom: "Q", texte: "Question : " + q.question },
        { nom: "R", texte: "Bonne réponse : " + q.question + " — " + q.choices[q.correct], aProuver: true },
      ], q.explanation, function (t) { q.explanation = t; }, function () { module.quiz[i] = null; });
    });
    return elements;
  }

  function racinesListe(texte) {
    return Object.keys(racinesDe(texte));
  }

  // Découpe le document en passages (phrases) et indexe leurs racines de mots.
  function creerRecuperateur(texteSource) {
    var passages = [];
    texteSource.split(/\n+/).forEach(function (ligne) {
      decouperPhrases(ligne).forEach(function (ph) {
        if (ph.length >= 15) passages.push({ n: passages.length + 1, texte: ph, racines: racinesListe(ph) });
      });
    });
    var df = {};
    passages.forEach(function (p) { p.racines.forEach(function (r) { df[r] = (df[r] || 0) + 1; }); });
    var N = passages.length || 1;

    return {
      passages: passages,
      // Les k passages les plus proches d'une phrase (racines communes, pondérées
      // par leur rareté dans le document).
      proches: function (phrase, k) {
        var rs = racinesListe(phrase);
        return passages
          .map(function (p) {
            var score = 0;
            rs.forEach(function (r) { if (p.racines.indexOf(r) !== -1) score += Math.log(1 + N / df[r]); });
            return { p: p, score: score };
          })
          .filter(function (x) { return x.score > 0; })
          .sort(function (a, b) { return b.score - a.score; })
          .slice(0, k)
          .map(function (x) { return x.p; });
      },
    };
  }

  function buildAuditPrompt() {
    return (
      "Tu es un vérificateur de fidélité, strict. On te donne des PHRASES générées à partir d'un cours. " +
      "Certaines « phrases » sont une proposition extraite d'une phrase plus longue (indiquée entre parenthèses) : ne juge que la proposition. " +
      "Sous chaque phrase figurent des PASSAGES du cours (P12, P40...), extraits du document d'origine.\n\n" +
      "Pour chaque phrase, désigne les passages qui établissent TOUT ce qu'elle affirme. Une reformulation fidèle est fondée. " +
      "Une phrase qui affirme PLUS que ces passages ne disent n'est pas fondée, même si elle est exacte dans la réalité : " +
      "détail technique ou scientifique, mécanisme, terme ou sigle que les passages n'expliquent pas, localisation, chiffre, nom, " +
      "date, comparaison (« la plus abondante », « le premier »), cause, conséquence, exemple, généralisation, " +
      "commentaire d'ensemble (« illustre l'importance de... »). Un mot du sujet présent dans un passage ne suffit pas : " +
      "c'est l'affirmation qui doit y figurer. Si aucun passage (seul ou avec d'autres) n'établit toute la phrase, réponds [].\n\n" +
      "Réponds UNIQUEMENT par un objet JSON : {\"verdicts\":[{\"id\":\"<id de la phrase, ex. g1.2 ou q3.R>\",\"passages\":[<numéros des passages, ex. 12, 40>]}]} " +
      "avec UNE entrée pour chaque phrase, dans l'ordre."
    );
  }

  function formaterElementsAudit(aProuver, candidats) {
    return aProuver
      .map(function (ph) {
        var lignes = [ph.sid + " : " + ph.texte];
        if (ph.complete && ph.complete.replace(/^[\s,;]+/, "") !== ph.texte) lignes.push("    (extrait de la phrase : « " + ph.complete + " »)");
        candidats[ph.sid].forEach(function (p) { lignes.push("    P" + p.n + " : " + p.texte); });
        return lignes.join("\n");
      })
      .join("\n\n");
  }

  // Applique les retraits au module et renvoie { corriges, supprimes }.
  function appliquerRetraits(module, elements) {
    var bilan = { corriges: 0, supprimes: 0 };
    elements.forEach(function (el) {
      var enteteRetiree = el.entetes.some(function (e) { return e.retiree; });
      var gardees = el.phrases.filter(function (ph) { return !ph.retiree; });
      var retraitPhrases = gardees.length !== el.phrases.length;
      var viderTout = el.aDuTexte && el.phrases.length > 0 && gardees.length === 0;

      if (enteteRetiree || viderTout) {
        el.retirer();
        bilan.supprimes++;
      } else if (retraitPhrases) {
        el.ecrire(reconstruireTexte(gardees.map(function (ph) { return { texte: ph.brut, phrase: ph.phrase }; })));
        bilan.corriges++;
      }
    });
    // Purge des éléments marqués null.
    function sansNull(l) { return (l || []).filter(function (x) { return x !== null; }); }
    module.glossary = sansNull(module.glossary);
    module.flashcards = sansNull(module.flashcards);
    module.quiz = sansNull(module.quiz);
    if (module.summary) {
      module.summary.keyPoints = sansNull(module.summary.keyPoints);
      module.summary.chapters = (module.summary.chapters || [])
        .map(function (ch) { return { title: ch.title, sections: sansNull(ch.sections) }; })
        .filter(function (ch) { return ch.sections.length > 0; });
    }
    return bilan;
  }

  // Renvoie une promesse de { corriges, supprimes } (+ echec: true si la partie
  // faite par le modèle n'a pas pu avoir lieu : le contrôle déterministe, lui,
  // s'est appliqué, et l'enseignant est averti dans l'éditeur).
  function auditerFidelite(module, texteSource) {
    var source = texteSource.length > 60000 ? texteSource.substring(0, 60000) : texteSource;
    var analyseur = creerAnalyseurSource(source);
    var elements = construireElementsAudit(module);
    if (!elements.length) return Promise.resolve({ corriges: 0, supprimes: 0 });

    // 1. Contrôle déterministe
    elements.forEach(function (el) {
      el.entetes.forEach(function (e) {
        if (e.terme && !analyseur.termePresent(e.terme)) {
          e.retiree = true;
          console.warn("SmartReviz — terme retiré (absent du document) : " + e.terme);
        }
      });
      el.entetes.concat(el.phrases).forEach(function (ph) {
        var absents = analyseur.termesTechniquesAbsents(ph.texte.replace(/^(Terme|Recto|Question|Bonne réponse) : /, ""));
        if (absents.length) {
          ph.retiree = true;
          console.warn("SmartReviz — phrase retirée (terme absent du document : " + absents.join(", ") + ") — " + ph.sid);
        }
      });
    });

    // 2. Recherche de passages, puis désignation par le modèle
    var recuperateur = creerRecuperateur(source);
    var restants = elements.filter(function (el) {
      return !el.entetes.some(function (e) { return e.retiree; }) && el.phrases.some(function (ph) { return !ph.retiree; });
    });
    var aProuver = [];
    var candidats = {};
    restants.forEach(function (el) {
      el.entetes.filter(function (e) { return e.aProuver && !e.retiree; }).concat(el.phrases.filter(function (ph) { return !ph.retiree; }))
        .forEach(function (ph) {
          aProuver.push(ph);
          candidats[ph.sid] = recuperateur.proches(ph.texte.replace(/^(Terme|Bonne réponse) : /, ""), 4);
        });
    });

    function finaliser(echec) {
      var bilan = appliquerRetraits(module, elements);
      if (echec) bilan.echec = true;
      console.log("SmartReviz — audit de fidélité :", bilan.corriges, "corrigé(s),", bilan.supprimes, "écarté(s)", echec ? "(partiel)" : "");
      return bilan;
    }

    if (!aProuver.length) return Promise.resolve(finaliser(false));

    function essayer(n) {
      return appelerProxy({
        max_tokens: 8192,
        temperature: 0,
        response_format: { type: "json_object" },
        system: buildAuditPrompt(),
        messages: [
          {
            role: "user",
            content: "PHRASES À VÉRIFIER :\n\n" + formaterElementsAudit(aProuver, candidats),
          },
        ],
      })
        .then(function (contenu) {
          var rep = decoderJSON(contenu);
          if (!rep || !Array.isArray(rep.verdicts) || !rep.verdicts.length) throw new Error("audit: réponse inattendue");
          var choisis = {};
          rep.verdicts.forEach(function (v) { if (v && typeof v.id === "string") choisis[v.id] = v.passages; });
          aProuver.forEach(function (ph) {
            var texte = ph.texte.replace(/^(Terme|Bonne réponse) : /, "");
            var nums = (Array.isArray(choisis[ph.sid]) ? choisis[ph.sid] : []).map(function (x) {
              return parseInt(String(x).replace(/^P/i, ""), 10);
            });
            var retenus = candidats[ph.sid].filter(function (p) { return nums.indexOf(p.n) !== -1; });
            var ok = retenus.length > 0 && preuveRecoupe(texte, retenus.map(function (p) { return p.texte; }).join(" "));
            if (!ok) {
              ph.retiree = true;
              console.warn(
                "SmartReviz — phrase retirée (" + (retenus.length ? "passages sans rapport" : "aucun passage ne l'établit") + ") " +
                  ph.sid + " : " + texte.slice(0, 100)
              );
            }
          });
          return finaliser(false);
        })
        .catch(function (err) {
          if (n < NB_ESSAIS_AUDIT) return essayer(n + 1);
          console.warn("SmartReviz — audit de fidélité par le modèle impossible :", err && err.message);
          return finaliser(true);
        });
    }
    return essayer(1);
  }

  // Le modèle dépasse régulièrement les cardinalités demandées (jusqu'à 30 termes
  // de glossaire, 11 flashcards, 11 questions). Plutôt que de rejeter une réponse
  // par ailleurs correcte, on ramène chaque liste au format attendu par le module
  // SCORM. L'enseignant peut de toute façon ajuster le contenu dans l'éditeur
  // avant de générer le paquet.
  function normaliserModule(module, nbCars) {
    function cap(nom, max, label) {
      if (!Array.isArray(module[nom])) return;
      if (module[nom].length > max) {
        console.warn("SmartReviz — " + module[nom].length + " " + label + " reçus, tronqué à " + max);
        module[nom] = module[nom].slice(0, max);
      }
    }
    cap("glossary", plafondPour("glossary", nbCars), "termes de glossaire");
    cap("flashcards", plafondPour("flashcards", nbCars), "flashcards");
    cap("quiz", plafondPour("quiz", nbCars), "questions QCM");
    if (module.summary && Array.isArray(module.summary.chapters)) {
      module.summary.chapters = module.summary.chapters.slice(0, plafondPour("summary", nbCars));
    }

    // Une question dont l'index de bonne réponse est hors des 4 choix rendrait le
    // QCM injouable : on l'écarte plutôt que de l'afficher.
    if (Array.isArray(module.quiz)) {
      var avant = module.quiz.length;
      module.quiz = module.quiz.filter(function (q) {
        return (
          q &&
          Array.isArray(q.choices) &&
          q.choices.length === 4 &&
          Number.isInteger(q.correct) &&
          q.correct >= 0 &&
          q.correct <= 3
        );
      });
      if (module.quiz.length !== avant) {
        console.warn(
          "SmartReviz — " + (avant - module.quiz.length) + " question(s) QCM malformée(s) écartée(s)"
        );
      }
    }
  }

  // Génère le module, puis ne redemande QUE les sections manquantes. Rejouer la
  // génération entière coûte ~35 s et bute souvent sur le même écueil, alors
  // qu'une requête ciblée sur la seule section absente produit une sortie bien
  // plus courte — donc nettement plus fiable, et bien plus rapide.
  function callLLMWithRetry(text, language, onStatus) {
    var MAX_TENTATIVES = 3;

    function manquantes(module) {
      return ALL_SECTIONS.filter(function (nom) {
        return !sectionValide(module, nom);
      });
    }

    function fusionner(base, ajout, demandees) {
      if (!base) return ajout;
      for (var i = 0; i < demandees.length; i++) {
        if (sectionValide(ajout, demandees[i])) base[demandees[i]] = ajout[demandees[i]];
      }
      return base;
    }

    function termine(module) {
      console.log(
        "SmartReviz — Données générées :",
        module.summary.chapters.length, "chapitres,",
        module.glossary.length, "termes,",
        module.flashcards.length, "flashcards,",
        module.quiz.length, "questions QCM"
      );
      return module;
    }

    function tenter(module, essai) {
      var absentes = module ? manquantes(module) : ALL_SECTIONS;
      // Sections présentes mais trop pauvres : on tente de les enrichir, sans
      // jamais bloquer la génération si le modèle n'y arrive pas.
      var faibles = module
        ? ALL_SECTIONS.filter(function (nom) {
            return absentes.indexOf(nom) === -1 && !sectionSuffisante(module, nom, text.length);
          })
        : [];

      if (absentes.length === 0 && (faibles.length === 0 || essai > MAX_TENTATIVES)) {
        if (faibles.length) {
          console.warn("SmartReviz — section(s) restée(s) en deçà du seuil : " + faibles.join(", "));
        }
        return Promise.resolve(termine(module));
      }

      if (essai > MAX_TENTATIVES) {
        throw new Error(SmartRevizI18n.t(ERREUR_SECTION[absentes[0]] || "errBadJSON"));
      }

      var aDemander = absentes.concat(faibles);
      if (module) {
        console.warn(
          "SmartReviz — à reprendre : " + aDemander.join(", ") +
            (absentes.length ? " (manquante(s) : " + absentes.join(", ") + ")" : " (trop pauvre(s))") +
            " — demande ciblée (tentative " + essai + "/" + MAX_TENTATIVES + ")"
        );
        if (onStatus) onStatus(aDemander);
      }

      return callLLMAPI(text, language, aDemander)
        .then(function (partiel) {
          // Une section trop pauvre n'est remplacée que si la nouvelle version
          // est réellement meilleure — sinon on garde ce qu'on avait.
          var retenues = aDemander.filter(function (nom) {
            if (absentes.indexOf(nom) !== -1) return true;
            return sectionValide(partiel, nom) && tailleSection(partiel, nom) > tailleSection(module, nom);
          });
          return tenter(fusionner(module, partiel, retenues), essai + 1);
        })
        .catch(function (err) {
          if (!err || !err.retryable || essai >= MAX_TENTATIVES) throw err;
          console.warn("SmartReviz — tentative " + essai + " échouée (" + err.message + "), nouvel essai…");
          return tenter(module, essai + 1);
        });
    }

    return Promise.resolve().then(function () {
      return tenter(null, 1);
    });
  }

  // Polices de la charte PracTice, embarquées dans le module. Elles voyagent
  // avec le paquet plutôt que d'être appelées chez Google : un module déposé
  // dans Moodle doit s'afficher correctement hors ligne, et aucune requête ne
  // doit partir vers un tiers depuis le navigateur de l'étudiant.
  var FONT_FILES = [
    "jakarta-latin.woff2",
    "jakarta-latin-ext.woff2",
    "dmsans-latin.woff2",
    "dmsans-latin-ext.woff2",
  ];

  var scormFontCache = {}; // nom -> ArrayBuffer

  // --- Load SCORM Template Files ---
  function loadScormTemplate() {
    var files = [
      "scorm-template/index.html",
      "scorm-template/style.css",
      "scorm-template/scorm-api.js",
      "scorm-template/module-data.js",
    ];

    // cache: "no-cache" force la revalidation auprès du serveur. GitHub Pages
    // sert ces fichiers avec max-age=600 : sans cela, un enseignant générant un
    // module dans les dix minutes suivant un déploiement embarquerait l'ancien
    // template dans son paquet SCORM.
    var promises = files.map(function (path) {
      return fetch(path, { cache: "no-cache" })
        .then(function (r) {
          return r.text();
        })
        .then(function (text) {
          scormTemplateCache[path.split("/").pop()] = text;
        });
    });

    promises = promises.concat(
      FONT_FILES.map(function (nom) {
        return fetch("scorm-template/fonts/" + nom, { cache: "no-cache" })
          .then(function (r) {
            return r.arrayBuffer();
          })
          .then(function (buf) {
            scormFontCache[nom] = buf;
          });
      })
    );

    return Promise.all(promises);
  }

  function arrayBufferEnBase64(buffer) {
    var octets = new Uint8Array(buffer);
    var binaire = "";
    // Par tranches : String.fromCharCode sur 40 000 octets d'un coup dépasse la
    // taille d'appel maximale sur certains navigateurs.
    for (var i = 0; i < octets.length; i += 8192) {
      binaire += String.fromCharCode.apply(null, octets.subarray(i, i + 8192));
    }
    return btoa(binaire);
  }

  // Remplace les url('fonts/…woff2') par des data: URI, pour l'export HTML
  // autonome où il n'y a pas de dossier fonts/ à côté du fichier.
  function inlinerPolices(css) {
    FONT_FILES.forEach(function (nom) {
      var buf = scormFontCache[nom];
      if (!buf) return;
      var dataURI = "data:font/woff2;base64," + arrayBufferEnBase64(buf);
      css = css.split("url('fonts/" + nom + "')").join("url(" + dataURI + ")");
    });
    return css;
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
      FONT_FILES.map(function (nom) {
        return '      <file href="fonts/' + nom + '"/>\n';
      }).join("") +
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

    FONT_FILES.forEach(function (nom) {
      if (scormFontCache[nom]) zip.file("fonts/" + nom, scormFontCache[nom]);
    });

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
      "<style>" + inlinerPolices(scormTemplateCache["style.css"]) + "</style>"
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
        // Asymptotic progress: starts fast, slows down, never stops until API responds
        startAnimatedProgress(35, 98, 40000, SmartRevizI18n.t("progressCallingAPI"));
        return callLLMWithRetry(extractedText, lang, function (absentes) {
          // Demande ciblée en cours : on le dit plutôt que de laisser la barre
          // tourner sans explication.
          setAnimatedProgressStatus(
            SmartRevizI18n.t("progressCompleting").replace(
              "{sections}",
              absentes
                .map(function (nom) {
                  return SmartRevizI18n.t("section_" + nom);
                })
                .join(", ")
            )
          );
        });
      })
      .then(function (moduleData) {
        stopAnimatedProgress();
        showProgress(99, SmartRevizI18n.t("progressAuditing"));
        return auditerFidelite(moduleData, extractedText).then(function (bilan) {
          fidelityReport = bilan;
          return moduleData;
        });
      })
      .then(function (moduleData) {
        moduleData.title = title;
        moduleData.language = lang;
        pendingModuleData = moduleData;
        pendingTitle = title;
        pendingLang = lang;

        progressPanel.classList.remove("active");
        showEditor(moduleData);
        showFidelityNotice(fidelityReport);
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
    renderTabMatching(data.matching && data.matching.length ? data.matching : data.glossary.slice(0, 8), data.glossary);
    renderTabFlashcards(data.flashcards);
    renderTabQuiz(data.quiz);
    editorPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showFidelityNotice(bilan) {
    var el = document.getElementById("fidelityNotice");
    var t = SmartRevizI18n.t;
    var texte, ok = true;
    if (!bilan || bilan.echec) {
      texte = t("fidelityFailed");
      ok = false;
    } else if (!bilan.corriges && !bilan.supprimes) {
      texte = t("fidelityClean");
    } else {
      texte = t("fidelityDone").replace("{c}", bilan.corriges).replace("{s}", bilan.supprimes);
    }
    el.textContent = texte;
    el.className = "fidelity-notice " + (ok ? "ok" : "warn");
    el.hidden = false;
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
      '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteTooltip")) + '"><svg class="icon"><use href="#i-x"/></svg></button>' +
    '</div>';
  }

  function chapterBlock(ch, ci) {
    var html = '<div class="chapter-block" data-ci="' + ci + '">';
    html += '<div class="chapter-block-header">';
    html += '<input type="text" class="ch-title" value="' + esc(ch.title || "") + '" placeholder="' + esc(SmartRevizI18n.t("placeholderChapterTitle")) + '">';
    html += '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteChapterTooltip")) + '"><svg class="icon"><use href="#i-x"/></svg></button>';
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
      '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteSectionTooltip")) + '"><svg class="icon"><use href="#i-x"/></svg></button>' +
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
      '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteTooltip")) + '"><svg class="icon"><use href="#i-x"/></svg></button>' +
    '</div>';
  }

  // --- MATCHING TAB (jeu de glisser-déposer) ---
  function renderTabMatching(pairs, glossary) {
    var el = document.getElementById("tab-matching");
    var t = SmartRevizI18n.t;
    var html = '<p class="editor-hint">' + esc(t("matchingIntro")) + '</p>';
    html += '<div id="ed-matching">';
    pairs.forEach(function(item, i) { html += matchingRow(item, i); });
    html += '</div>';
    html += '<div class="editor-actions">' +
      '<button class="btn-add-row" id="btnAddPair">' + esc(t("addPair")) + '</button> ' +
      '<button class="btn-add-row" id="btnPairsFromGloss">' + esc(t("matchingFromGlossary")) + '</button>' +
    '</div>';
    el.innerHTML = html;

    var container = document.getElementById("ed-matching");
    function refresh() {
      bindDeleteBtns(container);
      container.querySelectorAll(".btn-row-delete").forEach(function(btn) {
        var retirer = btn.onclick;
        btn.onclick = function() { retirer(); refresh(); };
      });
      document.getElementById("countMatching").textContent = container.querySelectorAll(".editor-row").length;
    }

    document.getElementById("btnAddPair").addEventListener("click", function() {
      var div = document.createElement("div");
      div.innerHTML = matchingRow({ term: "", definition: "" }, container.querySelectorAll(".editor-row").length);
      container.appendChild(div.firstChild);
      refresh();
    });

    // Le glossaire peut avoir été modifié depuis : on relit ses valeurs actuelles.
    document.getElementById("btnPairsFromGloss").addEventListener("click", function() {
      if (container.querySelector(".editor-row") && !confirm(t("matchingFromGlossaryConfirm"))) return;
      var current = [];
      document.querySelectorAll("#ed-glossary .editor-row").forEach(function(row) {
        var term = row.querySelector(".gloss-term").value.trim();
        if (term) current.push({ term: term, definition: row.querySelector(".gloss-def").value.trim() });
      });
      container.innerHTML = current.slice(0, 8).map(matchingRow).join("");
      refresh();
    });

    refresh();
  }

  function matchingRow(item, i) {
    return glossaryRow(item, i);
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
      '<button class="btn-row-delete" title="' + esc(SmartRevizI18n.t("deleteTooltip")) + '"><svg class="icon"><use href="#i-x"/></svg></button>' +
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
    html += '<span class="quiz-editor-toggle"><svg class="icon"><use href="#i-chevron-down"/></svg></span>';
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

    // Matching : une paire par terme (le jeu repère les termes par leur libellé)
    var matching = [];
    var seenTerms = {};
    document.querySelectorAll("#ed-matching .editor-row").forEach(function(row) {
      var term = row.querySelector(".gloss-term").value.trim();
      var def = row.querySelector(".gloss-def").value.trim();
      if (term && def && !seenTerms[term]) {
        seenTerms[term] = true;
        matching.push({ term: term, definition: def });
      }
    });
    data.matching = matching;

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
  var fidelityReport = null;

  var animatedStatusText = "";

  // Permet de changer le libellé sans interrompre l'animation en cours (utilisé
  // quand la génération repart sur une demande ciblée).
  function setAnimatedProgressStatus(statusText) {
    animatedStatusText = statusText;
  }

  function startAnimatedProgress(fromPercent, toPercent, durationMs, statusText) {
    animatedStatusText = statusText;
    showProgress(fromPercent, animatedStatusText);
    var startTime = Date.now();
    // Asymptotic progress: moves fast at first, then slows down
    // but NEVER stops — approaches toPercent without reaching it
    progressInterval = setInterval(function () {
      var elapsed = Date.now() - startTime;
      // Use 1 - e^(-t/tau) curve: fast start, gradual slowdown, never plateaus
      // tau calibrated so we reach ~75% of the range in durationMs
      var tau = durationMs / 1.4;
      var progress = 1 - Math.exp(-elapsed / tau);
      var current = Math.round(fromPercent + (toPercent - fromPercent) * progress);
      showProgress(current, animatedStatusText);
    }, 300);
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
