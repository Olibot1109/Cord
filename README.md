# Cord (Node.js backend)

Firebase has been removed. The app now uses a local Node.js backend with JSON persistence.

## Run

```bash
npm start
```

If port `3000` is in use:

```bash
PORT=4311 npm start
```

Then open:

- `http://localhost:3000`
- or `http://localhost:4311` if you changed the port

## Data storage

App data is stored in:

- `data/db.json`
