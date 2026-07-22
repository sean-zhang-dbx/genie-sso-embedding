#!/bin/bash
# Azure App Service (Linux, Python) startup command.
# Single worker: v1 keeps per-user Entra/Databricks tokens in an in-process
# session store, which must be authoritative across requests.
gunicorn app:app --workers 1 --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
