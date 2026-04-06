# Emotiate Eval

This repository contains evaluation tools for the **Emotiate** system — an AI-powered negotiation assistant that detects guest emotions during hotel negotiation conversations.

The repo is organized into two components:

---

## 1. `edm_evaluation/` — Emotion Detection Model Evaluation

Jupyter notebooks and data for evaluating the emotion detection capabilities of the Emotiate system.

**Notebooks:**

| Notebook | Description |
|---|---|
| `ED_Evaluation.ipynb` | Calls the Emotiate Spring Boot backend API and evaluates emotion detection accuracy against an annotated dataset |
| `LLM_Inference.ipynb` | Runs a selected prompt against the annotated dataset using an external LLM via the Groq API and saves accuracy results |
| `LLM_Evaluation.ipynb` | Compares and evaluates LLM inference results across models and prompts |

**Dataset:** `data/annotated_emotions.xlsx` — 600 annotated text samples across 6 emotion classes: `FRUSTRATED`, `HESITANT`, `NEUTRAL`, `INTERESTED`, `SATISFIED`, `EXCITED` (100 samples each).

**Supported emotions:** FRUSTRATED · HESITANT · NEUTRAL · INTERESTED · SATISFIED · EXCITED

**LLM results** from multiple models (Llama, Qwen, GPT) are stored in `llm_results/`.

### Prerequisites

```bash
pip install pandas openpyxl requests tqdm matplotlib
```

For `LLM_Inference.ipynb`, set your Groq API key:

```bash
export GROQ_API_KEY=your_key_here
```

For `ED_Evaluation.ipynb`, the Emotiate Spring Boot backend must be running at `http://localhost:8080`.

---

## 2. `guest_simulator/` — Guest Simulator

A React + Vite web app for simulating guest interactions with the Emotiate system, used to generate realistic negotiation conversations for evaluation and testing.

### Setup

```bash
cd guest_simulator
npm install
npm run dev
```
