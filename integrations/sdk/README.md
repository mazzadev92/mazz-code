# Clients MAZZ HTTP/SSE

Ces clients utilisent les endpoints réels du Studio. Ils refusent les origines distantes et les redirections. Ils ne démarrent pas de modèle et ne créent pas de session cloud.

Python (bibliothèque standard uniquement) :

```python
from mazz_client import MazzClient
client = MazzClient('http://127.0.0.1:3333')
session = client.create_session(r'D:\MonProjet')
for event in client.stream('Explique les fichiers du projet', session['id']):
    if event.get('type') == 'token':
        print(event['delta'], end='', flush=True)
```

JavaScript/TypeScript (Node 22+ ou navigateur autorisé par le Studio) :

```javascript
import {MazzClient} from './client.mjs';
const client = new MazzClient('http://127.0.0.1:3333');
const session = await client.createSession('D:\\MonProjet');
for await (const event of client.stream('Explique le projet', {sessionId:session.id})) {
  if (event.type === 'token') process.stdout.write(event.delta);
}
```

Le premier événement de métadonnées donne `taskId`. `cancel(taskId)` demande l’arrêt réel. Une déconnexion du flux seule n’annule pas la tâche. Le mode Ask lit; les mutations exigent le mode Agent et les permissions effectives du Studio. Une fin de flux ne certifie pas la justesse du contenu : consulter les événements `error`, `complete`, `tool_result` et les fichiers produits.
