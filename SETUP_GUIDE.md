# Avelon Backend Setup Guide

This guide provides step-by-step instructions to set up and run the **Avelon Backend** service (Node.js/Hono + Prisma + Hardhat).

---

## 📋 Prerequisites

Ensure you have the following installed:

- **Node.js**: ≥ 20.0.0
- **npm**: ≥ 10.0.0
- **Docker Desktop**: For PostgreSQL, Redis, and Ganache
- **Git**

---

## 🚀 Setup Instructions

### 1. Environment Configuration

1.  Navigate to the `avelon_backend` directory.
2.  Copy the example environment file:
    ```bash
    cp .env.example .env
    ```
3.  Update `.env` with your local configuration. Ensure `DATABASE_URL`, `REDIS_URL`, and `GANACHE_URL` match your Docker services.

### 2. Install Dependencies & Link Types

The backend relies on the shared `@avelon_capstone/types` package.

```bash
# Install backend dependencies
npm install

# Link the shared types package (assuming you have built it in ../avelon_types)
npm link @avelon_capstone/types
```

> **Note:** If `npm link` fails, ensure you have run `npm install && npm run build && npm link` inside the `avelon_types` directory first.

### 3. Start Infrastructure (Docker)

Start the required databases and blockchain emulator:

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL** (Port 5432)
- **Redis** (Port 6379)
- **Ganache** (Port 8545)

### 4. Database Setup

Initialize the database schema and seed it with initial data:

```bash
# Generate Prisma Client
npm run db:generate

# Push schema to the database
npm run db:push

# Seed the database
npm run db:seed
```

### 5. Smart Contracts (Optional/If needed)

If you need to deploy the smart contracts to the local Ganache instance:

```bash
# Compile contracts
npm run hardhat:compile

# Deploy to Ganache
npm run hardhat:deploy
```

> **Important:** Update your `.env` file with the deployed contract addresses if they change.

---

## 🏃‍♂️ Running the Server

Start the backend development server:

```bash
npm run dev
```

The server will start at **http://localhost:3001**.

---

## 🛠️ Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Starts the development server with hot-reloading |
| `npm run build` | Compiles the TypeScript code |
| `npm start` | Starts the production server |
| `npm run db:studio` | Opens Prisma Studio to view database data |
| `npm run lint` | Runs ESLint |
| `npm run format` | Formats code with Prettier |

---

## 🐛 Troubleshooting

- **`@avelon_capstone/types` not found**: Run `npm link` in `avelon_types`, then `npm link @avelon_capstone/types` in `avelon_backend`.
- **Database connection error**: Ensure Docker containers are running (`docker-compose ps`).
- **Prisma error**: Run `npm run db:generate` again.
