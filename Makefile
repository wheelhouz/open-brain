.PHONY: setup install dev build push deploy up down logs test clean

ENV ?= dev
COMPOSE := docker compose -p open-brain-$(ENV) --env-file .env.$(ENV)
DOCKER_IMAGE ?= ghcr.io/wheelhouz/open-brain:latest

setup:
	@for env in dev prod; do \
		if [ ! -f .env.$$env ]; then \
			cp .env.example .env.$$env; \
			PW=$$(openssl rand -hex 32); \
			sed -i "s/^DB_PASSWORD=$$/DB_PASSWORD=$$PW/" .env.$$env; \
			KEY=$$(openssl rand -hex 32); \
			sed -i "s/^BRAIN_ACCESS_KEY=$$/BRAIN_ACCESS_KEY=$$KEY/" .env.$$env; \
			echo "Created .env.$$env with generated secrets"; \
		else \
			echo ".env.$$env already exists, skipping"; \
		fi; \
	done
	@sed -i 's/^DB_PORT=.*/DB_PORT=5433/' .env.dev
	@sed -i 's/^DB_PORT=.*/DB_PORT=5432/' .env.prod
	@echo "Setup complete. Edit .env.dev and .env.prod to add OPENROUTER_API_KEY."

install:
	cd web && npm install
	cd app && npm install

dev: install
	$(COMPOSE) up -d db
	@echo "Waiting for database..."
	@until $(COMPOSE) exec db pg_isready -U brain_app -d open_brain -q 2>/dev/null; do sleep 1; done
	@echo "Database ready."
	@set -a && . ./.env.$(ENV) && set +a && \
		export DATABASE_URL="postgresql://brain_app:$$DB_PASSWORD@localhost:$$DB_PORT/open_brain" && \
		(cd web && npm run dev &) && \
		cd app && npm run dev

build:
	$(COMPOSE) build

push: build
	docker tag open-brain-$(ENV)-app:latest $(DOCKER_IMAGE) && \
	docker push $(DOCKER_IMAGE)

deploy:
	@echo "Waiting for GitHub Actions publish workflow to complete..."
	@RUN_ID=$$(gh run list --repo wheelhouz/open-brain --workflow=ci.yml --limit=1 --json databaseId --jq '.[0].databaseId') && \
	if [ -z "$$RUN_ID" ]; then echo "Error: No publish workflow run found"; exit 1; fi && \
	gh run watch --repo wheelhouz/open-brain $$RUN_ID --exit-status && \
	echo "Publish workflow completed." && \
	set -a && . ./.env.$(ENV) && set +a && \
	if [ -z "$$PORTAINER_API_KEY" ] || [ -z "$$PORTAINER_URL" ] || [ -z "$$PORTAINER_STACK_ID" ] || [ -z "$$PORTAINER_ENDPOINT_ID" ]; then \
		echo "Error: Set PORTAINER_API_KEY, PORTAINER_URL, PORTAINER_STACK_ID, PORTAINER_ENDPOINT_ID in .env.$(ENV)"; exit 1; \
	fi && \
	echo "Redeploying on Portainer..." && \
	STACK_FILE=$$(curl -sf -H "X-API-Key: $$PORTAINER_API_KEY" "$$PORTAINER_URL/api/stacks/$$PORTAINER_STACK_ID/file" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['StackFileContent']))") && \
	STACK_ENV=$$(curl -sf -H "X-API-Key: $$PORTAINER_API_KEY" "$$PORTAINER_URL/api/stacks/$$PORTAINER_STACK_ID" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['Env']))") && \
	curl -sf -X PUT \
		-H "X-API-Key: $$PORTAINER_API_KEY" \
		-H "Content-Type: application/json" \
		-d "{\"stackFileContent\": $$STACK_FILE, \"env\": $$STACK_ENV, \"prune\": true, \"pullImage\": true}" \
		"$$PORTAINER_URL/api/stacks/$$PORTAINER_STACK_ID?endpointId=$$PORTAINER_ENDPOINT_ID" > /dev/null && \
	echo "Deployed successfully."

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f app

test:
	cd app && BRAIN_ACCESS_KEY=test DATABASE_URL=postgres://x OPENROUTER_API_KEY=x npm test

clean:
	$(COMPOSE) down -v
