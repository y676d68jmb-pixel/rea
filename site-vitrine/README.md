# Site vitrine TSL (tsl.com.tn)

Site d'une seule page, sans base de données ni PHP : `index.html`, `style.css`, `img/` et `fonts/`. Il se dépose tel quel dans le dossier `httpdocs` de l'hébergement Plesk.

## Avant la mise en ligne

1. **Compléter les informations surlignées en jaune** dans `index.html` (classe `todo`) : téléphone, e-mail, adresse, horaires. Retirer ensuite la classe `todo` (ou demander à Claude de le faire).
2. **Renouveler le certificat HTTPS de tsl.com.tn** dans Plesk : *Sites Web & Domaines → tsl.com.tn → SSL/TLS → Let's Encrypt → Renouveler*, en couvrant `tsl.com.tn` et `www.tsl.com.tn`.

## Mise en ligne dans Plesk

1. **Sauvegarder l'ancien site** : *Fichiers → httpdocs*, tout sélectionner → *Ajouter à l'archive*, puis télécharger l'archive.
2. Déplacer les anciens fichiers dans un sous-dossier (par exemple `ancien-site`) ou les supprimer une fois la sauvegarde téléchargée.
3. Envoyer `site-vitrine.zip` dans `httpdocs` (*Télécharger*), puis *Extraire les fichiers* : `index.html` doit se trouver directement dans `httpdocs`.
4. Ouvrir https://tsl.com.tn pour vérifier.

## Crédits

- Photos sous [licence Unsplash](https://unsplash.com/license) : Bent Van Aeken (navire vu du ciel), Wolfgang Weiser (port au crépuscule), Maksym Kaharlytskyi (quai et grue), Peaky_82 (avion cargo), Bhargav Panchal (camions), Lance Chang (entrepôt).
- Police [Manrope](https://github.com/sharanda/manrope), licence SIL Open Font License 1.1 (`fonts/OFL-manrope.txt`).
