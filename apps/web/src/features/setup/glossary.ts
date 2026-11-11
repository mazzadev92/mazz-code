/** Définitions courtes des termes techniques de l'assistant (source : docs/setup/ASSISTANT_PREMIER_LANCEMENT.md). */
export interface GlossaryEntry { label: string; text: string }

export const GLOSSARY: Record<string, GlossaryEntry> = {
  modele: { label: 'Modèle', text: 'Le programme d’IA lui-même (un gros fichier de nombres).' },
  parametres: { label: 'Paramètres (7B, 14B…)', text: 'Taille du modèle en milliards de valeurs ; plus c’est gros, plus il est capable et plus il demande de mémoire.' },
  gguf: { label: 'GGUF', text: 'Format de fichier de modèle pour les ordinateurs ordinaires (CPU et petits GPU).' },
  quantification: { label: 'Quantification (Q4_K_M…)', text: 'Compression du modèle pour qu’il tienne en mémoire ; Q4 est un bon compromis.' },
  vram: { label: 'VRAM / RAM', text: 'Mémoire du GPU / de l’ordinateur ; le modèle doit tenir dedans.' },
  gpu: { label: 'GPU', text: 'Puce graphique qui accélère l’IA ; les services gratuits en prêtent pour quelques heures.' },
  quota: { label: 'Quota', text: 'Limite gratuite (par minute, jour, semaine ou mois) ; au-delà, il faut attendre ou payer.' },
  cle: { label: 'Jeton / clé API', text: 'Mot de passe d’un service pour qu’une application l’utilise à votre place ; ne le partagez jamais.' },
  huggingface: { label: 'Hugging Face', text: 'Grande bibliothèque en ligne de modèles. Les modèles officiels MAZZ se téléchargent sans compte ni jeton ; un jeton n’est utile que pour vos propres dépôts.' },
  kaggle: { label: 'Kaggle', text: 'Service gratuit de Google offrant 30h de GPU par semaine. La validation de votre numéro de téléphone par SMS est obligatoire pour débloquer le GPU.' },
  colab: { label: 'Colab', text: 'Google Colab : service de notebooks avec GPU T4 gratuit pour lancer des calculs et modèles dans le cloud.' },
  modal: { label: 'Modal', text: 'Plateforme de calcul GPU cloud offrant 30 $ de crédit gratuit par mois, sans carte bancaire requise.' },
  tunnel: { label: 'Tunnel', text: 'Passage sécurisé entre un GPU distant et votre ordinateur, sans ouvrir de port.' },
  contexte: { label: 'Contexte', text: 'Longueur de texte que le modèle voit d’un coup.' },
  agent: { label: 'Agent', text: 'Mode où l’IA peut lire et modifier vos fichiers et lancer des commandes, avec votre autorisation.' },
};
