# Thin wrapper around docker compose. `make up` is the one command you need.
#
# Run from Trademart_B/deploy/.

.DEFAULT_GOAL := help
.PHONY: help up start stop restart down destroy build rebuild logs logs-backend logs-frontend logs-nginx ps status health shell-backend shell-mongo config renew nginx-test nginx-reload

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

up: ## Build, boot the stack, and obtain TLS certificates (idempotent)
	./start.sh

start: ## Boot without rebuilding images
	./start.sh --skip-build

build: ## Build images only
	docker compose build

rebuild: ## Rebuild images from scratch, then boot
	docker compose build --no-cache
	./start.sh --skip-build

stop: ## Stop containers (they stay stopped until `make start`)
	docker compose stop

restart: ## Restart containers in place
	docker compose restart

down: ## Remove containers and the network, keeping all volumes/data
	docker compose down --remove-orphans

destroy: ## Remove containers AND volumes - DELETES CERTIFICATES (and the local DB, if enabled)
	@printf 'This deletes all volumes: your TLS certificates and, if the local database is enabled, its data. Type "yes" to continue: ' \
	  && read ans && [ "$$ans" = "yes" ] || (echo "aborted"; exit 1)
	docker compose down -v --remove-orphans

logs: ## Tail logs from every service
	docker compose logs -f --tail=100

logs-backend: ## Tail backend logs
	docker compose logs -f --tail=200 backend

logs-frontend: ## Tail frontend logs
	docker compose logs -f --tail=200 frontend

logs-nginx: ## Tail nginx logs
	docker compose logs -f --tail=200 nginx

ps: ## Show container state and health
	docker compose ps

status: ps ## Alias for `make ps`

health: ## Curl the API health endpoint from inside the network
	docker compose exec -T backend node -e \
	  "fetch('http://127.0.0.1:4000/api/health').then(r=>r.text()).then(t=>console.log(t))"

config: ## Print the fully resolved compose configuration
	docker compose config

nginx-test: ## Validate the rendered nginx configuration
	docker compose exec -T nginx nginx -t

nginx-reload: ## Reload nginx without dropping connections
	docker compose exec -T nginx nginx -s reload

renew: ## Force a certificate renewal now
	./start.sh --skip-build --force-renew

shell-backend: ## Shell into the backend container
	docker compose exec backend sh

shell-mongo: ## Open a mongosh session against the LOCAL database (local-db mode only)
	@docker compose ps --services 2>/dev/null | grep -qx mongo \
	  || { echo "No local 'mongo' service - the database is external (Atlas). Use its own tools, e.g. the Atlas UI or 'mongosh \"$$MONGODB_URI\"'."; exit 1; }
	docker compose exec mongo sh -c \
	  'mongosh -u "$$MONGO_INITDB_ROOT_USERNAME" -p "$$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
