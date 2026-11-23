-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "secretKeyHash" TEXT NOT NULL,
    "allowedOrigins" TEXT[],
    "repoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Span" (
    "projectId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "parentSpanId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "ingestSource" TEXT NOT NULL,
    "errorMessage" TEXT,
    "sourceFile" TEXT,
    "sourceLine" INTEGER,
    "attributes" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Span_pkey" PRIMARY KEY ("projectId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Project_publicKey_key" ON "Project"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "Project_secretKeyHash_key" ON "Project"("secretKeyHash");

-- CreateIndex
CREATE INDEX "Span_projectId_traceId_idx" ON "Span"("projectId", "traceId");

-- CreateIndex
CREATE INDEX "Span_projectId_startTime_idx" ON "Span"("projectId", "startTime");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Span" ADD CONSTRAINT "Span_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
