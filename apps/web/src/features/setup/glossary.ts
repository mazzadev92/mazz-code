/** Définitions courtes des termes techniques de l'assistant (source : docs/setup/ASSISTANT_PREMIER_LANCEMENT.md). */
export interface GlossaryEntry { label: string; text: string }

const NOTEBOOK = 'Service qui prête un GPU ; Kaggle et Colab fonctionnent par notebook, Modal par appel à la demande.';

export const GLOSSARY: Record<string, GlossaryEntry> = {
  modele: { label: 'Modèle', text: 'Le programme d’IA lui-même (un gros fichier de nombres).' },
  parametres: { label: 'Paramètres (7B, 14B…)', text: 'Taille du modèle en milliards de valeurs ; plus c’est gros, plus il est capable et plus il demande de mémoire.' },
  gguf: { label: 'GGUF', text: 'Format de fichier de modèle pour les ordinateurs ordinaires (CPU et petits GPU).' },
  quantification: { label: 'Quantification (Q4_K_M…)', text: 'Compression du modèle pour qu’il tienne en mémoire ; Q4 est un bon compromis.' },
  vram: { label: 'VRAM / RAM', text: 'Mémoire du GPU / de l’ordinateur ; le modèle doit tenir dedans.' },
  gpu: { label: 'GPU', text: 'Puce graphique qui accélère l’IA ; les services gratuits en prêtent pour quelques heures.' },
  quota: { label: 'Quota', text: 'Limite gratuite (par minute, jour, semaine ou mois) ; au-delà, il faut attendre ou payer.' },
  cle: { label: 'Jeton / clé API', text: 'Mot de passe d’un service pour qu’une application l’utilise à votre place ; ne le partagez jamais.' },
  huggingface: { label: 'Hugging Face', text: 'Bibliothèque en ligne de modèles ; un compte gratuit et un jeton permettent de les télécharger.' },
  kaggle: { label: 'Kaggle', text: NOTEBOOK },
  colab: { label: 'Colab', text: NOTEBOOK },
  modal: { label: 'Modal', text: NOTEBOOK },
  tunnel: { label: 'Tunnel', text: 'Passage sécurisé entre un GPU distant et votre ordinateur, sans ouvrir de port.' },
  contexte: { label: 'Contexte', text: 'Longueur de texte que le modèle voit d’un coup.' },
  agent: { label: 'Agent', text: 'Mode où l’IA peut lire et modifier vos fichiers et lancer des commandes, avec votre autorisation.' },
};
