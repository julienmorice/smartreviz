// IMT-BS SmartReviz — Internationalization
(function () {
  "use strict";

  var translations = {
    fr: {
      // Page title
      pageTitle: "IMT-BS SmartReviz — Générateur de modules SCORM",

      // Hero
      heroSubtitle: "Transformez vos supports de cours en modules de révision interactifs — intégrables à Moodle en SCORM ou téléchargeables en HTML autonome.",
      badgeMoodle: "&#127891; Compatible Moodle",
      badgeHTML: "&#128196; Export HTML",
      badgeAI: "&#129302; Généré par IA",

      // Features strip
      featResume: "Résumé",
      featGlossaire: "Glossaire",
      featMatching: "Matching",
      featFlashcards: "Flashcards",
      featQCM: "QCM",

      // Step 1
      step1Title: "Votre document de cours",
      dzText: "Glissez votre fichier ici ou cliquez",
      dzFormats: ".txt \u00a0·\u00a0 .md \u00a0·\u00a0 .docx \u00a0·\u00a0 .pdf",
      toggleText: "ou coller du texte directement",
      textPlaceholder: "Collez le contenu de votre cours ici...",

      // Step 2
      step2Title: "Options",
      labelTitle: "Titre du module",
      titlePlaceholder: "Ex : Éthique de l'IA en santé",
      labelLang: "Langue du module",
      langFR: "&#127467;&#127479; Français",
      langEN: "&#127468;&#127463; Anglais",

      // Generate
      btnGenerate: "Générer le module",

      // Editor
      step3Title: "Vérifiez et modifiez le contenu généré",
      editorSubtitle: "Corrigez les éventuelles erreurs de l'IA avant de générer votre module.",
      tabSummary: "&#128209; Résumé",
      tabGlossary: "&#128218; Glossaire",
      tabFlashcards: "&#127183; Flashcards",
      tabQuiz: "&#9989; QCM",
      btnValidate: "&#10024; Valider et générer le module",

      // Editor labels
      edOverview: "Vue d'ensemble",
      edKeyPoints: "Points clés",
      edChapters: "Chapitres",
      addKeypoint: "+ Ajouter un point clé",
      addChapter: "+ Ajouter un chapitre",
      newChapter: "Nouveau chapitre",
      addSection: "+ Section",
      addTerm: "+ Ajouter un terme",
      addFlashcard: "+ Ajouter une flashcard",
      addQuestion: "+ Ajouter une question",
      placeholderKeypoint: "Point clé...",
      placeholderChapterTitle: "Titre du chapitre",
      placeholderSectionTitle: "Titre de la section",
      placeholderTerm: "Terme",
      placeholderFront: "Recto (question / terme)",
      placeholderQuestionText: "Énoncé de la question",
      placeholderAnswer: "Réponse",
      labelType: "Type :",
      typeConcept: "Concept",
      typeQuestion: "Question",
      labelChoices: "Choix de réponses",
      labelCorrectAnswer: "Bonne réponse :",
      labelExplanation: "Explication",
      placeholderExplanation: "Explication de la bonne réponse",
      btnDeleteQuestion: "&#128465; Supprimer",
      questionPlaceholder: "Question…",
      deleteTooltip: "Supprimer",
      deleteChapterTooltip: "Supprimer le chapitre",
      deleteSectionTooltip: "Supprimer la section",
      deleteQuestionTooltip: "Supprimer la question",

      // Progress
      progressTitle: "Génération en cours…",
      progressInit: "Initialisation…",
      progressExtracting: "Extraction du texte...",
      progressLoadingTemplates: "Chargement des templates SCORM...",
      progressCallingAPI: "Appel API Claude — génération du contenu pédagogique...",
      progressBuilding: "Construction du package SCORM...",
      progressDone: "Terminé !",

      // Error
      errorLabel: "&#9888; Erreur",

      // Result
      resultTitle: "Module prêt !",
      resultHint: "Choisissez votre format de téléchargement",
      btnSCORM: "&#128230; SCORM pour Moodle",
      btnHTML: "&#127758; HTML autonome",
      btnPreview: "&#128065; Prévisualiser",

      // Video section
      videoTitle: "Voir SmartReviz en action",
      videoSubtitle: "Découvrez comment générer un module de révision complet en quelques minutes",
      videoIframeTitle: "Lecteur vidéo",

      // Carousel
      carouselTitle: "Aperçu du module généré",
      carouselSubtitle: "5 activités interactives créées automatiquement à partir de votre cours",
      slide1: "01 — Résumé",
      slide2: "02 — Glossaire",
      slide3: "03 — Matching",
      slide4: "04 — Flashcards",
      slide5: "05 — QCM",
      carouselPrevLabel: "Précédent",
      carouselNextLabel: "Suivant",

      // Errors / messages
      errUnsupportedFormat: "Format non supporté. Utilisez .txt, .md, .docx ou .pdf",
      errNoInput: "Veuillez uploader un fichier ou coller du texte.",
      errTextTooShort: "Le texte extrait est trop court. Vérifiez votre document.",
      errFileRead: "Erreur de lecture du fichier",
      errFileReadDOCX: "Erreur de lecture du fichier DOCX",
      errFileReadPDF: "Erreur de lecture du fichier PDF",
      errSummary: "Le résumé n'a pas été généré correctement.",
      errGlossary: "Le glossaire n'a pas été généré.",
      errFlashcards: "Les flashcards n'ont pas été générées. Réessayez.",
      errQuiz: "Le QCM n'a pas été généré. Réessayez.",
      errEmptyQuiz: "Le QCM est vide. Ajoutez au moins une question.",
      errEmptyFlashcards: "Les flashcards sont vides. Ajoutez au moins une carte.",
      errTimeout: "La génération a pris trop de temps. Essayez avec un document plus court ou réessayez.",
      errGeneric: "Une erreur est survenue.",
      errGenerating: "Erreur lors de la génération.",
      defaultTitle: "Module de révision",

      // Footer
      footerAuthor: "Auteur : Julien MORICE"
    },

    en: {
      // Page title
      pageTitle: "IMT-BS SmartReviz — SCORM Module Generator",

      // Hero
      heroSubtitle: "Turn your course materials into interactive revision modules — ready for Moodle as SCORM or downloadable as standalone HTML.",
      badgeMoodle: "&#127891; Moodle Compatible",
      badgeHTML: "&#128196; HTML Export",
      badgeAI: "&#129302; AI Generated",

      // Features strip
      featResume: "Summary",
      featGlossaire: "Glossary",
      featMatching: "Matching",
      featFlashcards: "Flashcards",
      featQCM: "Quiz",

      // Step 1
      step1Title: "Your course document",
      dzText: "Drag your file here or click",
      dzFormats: ".txt \u00a0·\u00a0 .md \u00a0·\u00a0 .docx \u00a0·\u00a0 .pdf",
      toggleText: "or paste text directly",
      textPlaceholder: "Paste your course content here...",

      // Step 2
      step2Title: "Options",
      labelTitle: "Module title",
      titlePlaceholder: "E.g.: Ethics of AI in Healthcare",
      labelLang: "Module language",
      langFR: "&#127467;&#127479; French",
      langEN: "&#127468;&#127463; English",

      // Generate
      btnGenerate: "Generate module",

      // Editor
      step3Title: "Review and edit the generated content",
      editorSubtitle: "Fix any AI errors before generating your module.",
      tabSummary: "&#128209; Summary",
      tabGlossary: "&#128218; Glossary",
      tabFlashcards: "&#127183; Flashcards",
      tabQuiz: "&#9989; Quiz",
      btnValidate: "&#10024; Validate and generate module",

      // Editor labels
      edOverview: "Overview",
      edKeyPoints: "Key points",
      edChapters: "Chapters",
      addKeypoint: "+ Add a key point",
      addChapter: "+ Add a chapter",
      newChapter: "New chapter",
      addSection: "+ Section",
      addTerm: "+ Add a term",
      addFlashcard: "+ Add a flashcard",
      addQuestion: "+ Add a question",
      placeholderKeypoint: "Key point...",
      placeholderChapterTitle: "Chapter title",
      placeholderSectionTitle: "Section title",
      placeholderTerm: "Term",
      placeholderFront: "Front (question / term)",
      placeholderQuestionText: "Question statement",
      placeholderAnswer: "Answer",
      labelType: "Type:",
      typeConcept: "Concept",
      typeQuestion: "Question",
      labelChoices: "Answer choices",
      labelCorrectAnswer: "Correct answer:",
      labelExplanation: "Explanation",
      placeholderExplanation: "Explanation of the correct answer",
      btnDeleteQuestion: "&#128465; Delete",
      questionPlaceholder: "Question…",
      deleteTooltip: "Delete",
      deleteChapterTooltip: "Delete chapter",
      deleteSectionTooltip: "Delete section",
      deleteQuestionTooltip: "Delete question",

      // Progress
      progressTitle: "Generating…",
      progressInit: "Initializing…",
      progressExtracting: "Extracting text...",
      progressLoadingTemplates: "Loading SCORM templates...",
      progressCallingAPI: "Calling Claude API — generating educational content...",
      progressBuilding: "Building SCORM package...",
      progressDone: "Done!",

      // Error
      errorLabel: "&#9888; Error",

      // Result
      resultTitle: "Module ready!",
      resultHint: "Choose your download format",
      btnSCORM: "&#128230; SCORM for Moodle",
      btnHTML: "&#127758; Standalone HTML",
      btnPreview: "&#128065; Preview",

      // Video section
      videoTitle: "See SmartReviz in action",
      videoSubtitle: "Learn how to generate a complete revision module in just a few minutes",
      videoIframeTitle: "Video player",

      // Carousel
      carouselTitle: "Preview of the generated module",
      carouselSubtitle: "5 interactive activities automatically created from your course",
      slide1: "01 — Summary",
      slide2: "02 — Glossary",
      slide3: "03 — Matching",
      slide4: "04 — Flashcards",
      slide5: "05 — Quiz",
      carouselPrevLabel: "Previous",
      carouselNextLabel: "Next",

      // Errors / messages
      errUnsupportedFormat: "Unsupported format. Use .txt, .md, .docx or .pdf",
      errNoInput: "Please upload a file or paste text.",
      errTextTooShort: "The extracted text is too short. Check your document.",
      errFileRead: "Error reading the file",
      errFileReadDOCX: "Error reading the DOCX file",
      errFileReadPDF: "Error reading the PDF file",
      errSummary: "The summary was not generated correctly.",
      errGlossary: "The glossary was not generated.",
      errFlashcards: "Flashcards were not generated. Please try again.",
      errQuiz: "The quiz was not generated. Please try again.",
      errEmptyQuiz: "The quiz is empty. Add at least one question.",
      errEmptyFlashcards: "Flashcards are empty. Add at least one card.",
      errTimeout: "Generation took too long. Try with a shorter document or try again.",
      errGeneric: "An error occurred.",
      errGenerating: "Error during generation.",
      defaultTitle: "Revision module",

      // Footer
      footerAuthor: "Author: Julien MORICE"
    }
  };

  // --- Current language ---
  var currentLang = localStorage.getItem("smartreviz-ui-lang") || "fr";

  // --- Public API ---
  window.SmartRevizI18n = {
    t: function (key) {
      return (translations[currentLang] && translations[currentLang][key]) ||
             (translations.fr && translations.fr[key]) ||
             key;
    },

    getLang: function () {
      return currentLang;
    },

    setLang: function (lang) {
      if (!translations[lang]) return;
      currentLang = lang;
      localStorage.setItem("smartreviz-ui-lang", lang);
      document.documentElement.lang = lang;
      this.applyAll();
    },

    applyAll: function () {
      var self = this;

      // Update page title
      document.title = self.t("pageTitle");

      // data-i18n → textContent / innerHTML
      document.querySelectorAll("[data-i18n]").forEach(function (el) {
        var key = el.getAttribute("data-i18n");
        var val = self.t(key);
        // Use innerHTML for keys containing HTML entities
        if (val.indexOf("&") !== -1 || val.indexOf("<") !== -1) {
          el.innerHTML = val;
        } else {
          el.textContent = val;
        }
      });

      // data-i18n-placeholder
      document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
        el.placeholder = self.t(el.getAttribute("data-i18n-placeholder"));
      });

      // data-i18n-aria
      document.querySelectorAll("[data-i18n-aria]").forEach(function (el) {
        el.setAttribute("aria-label", self.t(el.getAttribute("data-i18n-aria")));
      });

      // data-i18n-title (iframe title, etc.)
      document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
        el.title = self.t(el.getAttribute("data-i18n-title"));
      });

      // Update language switcher active state
      document.querySelectorAll(".lang-btn").forEach(function (btn) {
        btn.classList.toggle("active", btn.dataset.lang === currentLang);
      });
    }
  };

  // Apply on load
  document.addEventListener("DOMContentLoaded", function () {
    window.SmartRevizI18n.applyAll();
  });
})();
