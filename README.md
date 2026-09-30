# WikiMasters Auction Alert

Extension Chrome Manifest V3 qui surveille passivement les comptes à rebours des enchères ouvertes sur `www.wiki-masters.com` et prévient l’utilisateur avant leur fin.

L’extension ne clique sur aucun élément, ne place aucune enchère et n’intercepte aucun trafic réseau. Elle lit uniquement le DOM déjà affiché dans les onglets WikiMasters.

## Installation locale

1. Ouvrir `chrome://extensions` dans Chrome.
2. Activer le **Mode développeur** en haut à droite.
3. Cliquer sur **Charger l’extension non empaquetée**.
4. Sélectionner le dossier de ce projet.
5. Épingler l’extension depuis le menu des extensions si nécessaire.

## Utilisation

Ouvrir la popup depuis la barre d’outils, choisir le délai souhaité et activer les canaux d’alerte. Les réglages sont conservés localement dans Chrome.

Le bouton **Tester l’alerte** utilise les réglages Notification, Son et Mise au premier plan, même lorsque la surveillance générale est désactivée.

## Arborescence

```text
wikimasters-alert/
├── manifest.json
├── background.js
├── content.js
├── alert.html
├── alert.js
├── alert.css
├── popup.html
├── popup.js
├── popup.css
├── offscreen.html
├── offscreen.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── sounds/
│   └── alert.wav
└── tests/
    └── content.test.js
```

## Vérification rapide

Exécuter `node tests/content.test.js` puis `node tests/background.test.js` depuis ce dossier pour valider le parsing des comptes à rebours et le canal de notification. Ces tests ne requièrent aucune installation ni dépendance npm.

La popup affiche aussi le nombre d’enchères reconnues dans l’onglet WikiMasters actif. Après une mise à jour de l’extension, il faut recharger cet onglet pour injecter la nouvelle version du détecteur.

Le canal visuel ouvre une petite fenêtre Chrome interne à l’extension. Il ne dépend pas des notifications Windows ni du mode *Ne pas déranger*. Le bouton **Voir l’enchère** ramène à l’onglet d’origine.

Chaque enchère reconnue dans l’onglet actif apparaît également dans la popup avec son propre interrupteur. Désactiver cet interrupteur coupe uniquement cette enchère ; les autres restent surveillées. Ce choix est conservé dans le stockage local de l’extension.

## Ajuster la détection du site

La détection générique couvre les compteurs `HH:MM:SS`, `MM:SS`, `32 s`, `32 sec` et `1 min 20 s`. Les sélecteurs spécifiques sont regroupés sous le commentaire `WIKIMASTERS SELECTORS` dans `content.js`.

Pour relever le DOM réel d’une enchère authentifiée :

1. Ouvrir la page d’enchères WikiMasters.
2. Appuyer sur `F12` ou utiliser `Ctrl+Maj+I` (`Cmd+Option+I` sur macOS).
3. Cliquer sur l’outil de sélection d’élément dans DevTools.
4. Cliquer sur le compte à rebours, puis relever sa balise, ses classes et ses attributs `data-*`.
5. Refaire l’opération sur le conteneur de l’enchère et son titre.

Les erreurs du content script sont visibles dans l’onglet **Console** des DevTools de la page. Les erreurs du service worker sont accessibles depuis `chrome://extensions`, via le lien **Service worker** de l’extension.
