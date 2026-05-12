.DEFAULT_GOAL := help
PYTHON        := python3
PIP           := pip3
PORT          := 5000
PAGES_PORT    := 8090

.PHONY: help install run run-dev test docker-build docker-up docker-down pages clean

help: ## Zeigt diese Hilfe an
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ── Python / Flask ────────────────────────────────────────────────────────────

install: ## Abhängigkeiten installieren (requirements.txt)
	$(PIP) install -r requirements.txt

run: ## Flask-App starten (Port $(PORT))
	$(PYTHON) start.py

run-dev: ## Flask-App im Debug-Modus starten
	FLASK_ENV=development FLASK_DEBUG=1 $(PYTHON) start.py

test: ## Setup-Tests ausführen
	$(PYTHON) test_setup.py

# ── Docker ────────────────────────────────────────────────────────────────────

docker-build: ## Docker-Image bauen
	docker compose build

docker-up: ## Container starten (docker compose up -d)
	docker compose up -d

docker-down: ## Container stoppen und entfernen
	docker compose down

# ── GitHub Pages (web/) ──────────────────────────────────────────────────────

pages: ## GH-Pages-Seite lokal unter http://localhost:$(PAGES_PORT) testen
	@echo "Serving web/ at http://localhost:$(PAGES_PORT)  (Ctrl+C zum Beenden)"
	@cd web && $(PYTHON) -m http.server $(PAGES_PORT)

# ── Aufräumen ─────────────────────────────────────────────────────────────────

clean: ## Temporäre Dateien und __pycache__ entfernen
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name '*.pyc' -delete
	rm -rf sessions/*.json 2>/dev/null || true
