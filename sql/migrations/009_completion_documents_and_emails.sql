/*
  Migration 009 - separate audit PDF and independently tracked completion emails
  -----------------------------------------------------------------------------
  Run in SSMS against your database, or: npm run db:migrate
  Safe to re-run.
*/

IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_ContractDocuments_Kind'
    AND object_id = OBJECT_ID(N'eSign.ContractDocuments')
    AND definition NOT LIKE N'%audit%'
)
  ALTER TABLE eSign.ContractDocuments DROP CONSTRAINT CK_ContractDocuments_Kind;
GO
IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_ContractDocuments_Kind'
    AND object_id = OBJECT_ID(N'eSign.ContractDocuments')
)
  ALTER TABLE eSign.ContractDocuments
    ADD CONSTRAINT CK_ContractDocuments_Kind CHECK (Kind IN (N'original', N'signed', N'audit'));
GO

IF COL_LENGTH(N'eSign.Contracts', N'SignedPdfStatus') IS NULL
  ALTER TABLE eSign.Contracts ADD SignedPdfStatus NVARCHAR(10) NOT NULL
    CONSTRAINT DF_Contracts_SignedPdfStatus DEFAULT N'pending'
    CONSTRAINT CK_Contracts_SignedPdfStatus CHECK (SignedPdfStatus IN (N'pending', N'generating', N'ready', N'failed'));
GO
IF COL_LENGTH(N'eSign.Contracts', N'SignedPdfStartedAt') IS NULL
  ALTER TABLE eSign.Contracts ADD SignedPdfStartedAt DATETIME2(0) NULL;
GO
IF COL_LENGTH(N'eSign.Contracts', N'SignedPdfGeneratedAt') IS NULL
  ALTER TABLE eSign.Contracts ADD SignedPdfGeneratedAt DATETIME2(0) NULL;
GO
IF COL_LENGTH(N'eSign.Contracts', N'SignedPdfError') IS NULL
  ALTER TABLE eSign.Contracts ADD SignedPdfError NVARCHAR(1000) NULL;
GO
IF COL_LENGTH(N'eSign.Contracts', N'AuditPdfStatus') IS NULL
  ALTER TABLE eSign.Contracts ADD AuditPdfStatus NVARCHAR(10) NOT NULL
    CONSTRAINT DF_Contracts_AuditPdfStatus DEFAULT N'pending'
    CONSTRAINT CK_Contracts_AuditPdfStatus CHECK (AuditPdfStatus IN (N'pending', N'generating', N'ready', N'failed'));
GO
IF COL_LENGTH(N'eSign.Contracts', N'AuditPdfStartedAt') IS NULL
  ALTER TABLE eSign.Contracts ADD AuditPdfStartedAt DATETIME2(0) NULL;
GO
IF COL_LENGTH(N'eSign.Contracts', N'AuditPdfGeneratedAt') IS NULL
  ALTER TABLE eSign.Contracts ADD AuditPdfGeneratedAt DATETIME2(0) NULL;
GO
IF COL_LENGTH(N'eSign.Contracts', N'AuditPdfError') IS NULL
  ALTER TABLE eSign.Contracts ADD AuditPdfError NVARCHAR(1000) NULL;
GO

IF OBJECT_ID(N'eSign.ContractEmailDeliveries', N'U') IS NULL
CREATE TABLE eSign.ContractEmailDeliveries (
  ContractId    NVARCHAR(32) NOT NULL CONSTRAINT FK_ContractEmailDeliveries_Contracts REFERENCES eSign.Contracts (Id) ON DELETE CASCADE,
  SignerOrder   INT          NOT NULL,
  Kind          NVARCHAR(10) NOT NULL CONSTRAINT CK_ContractEmailDeliveries_Kind CHECK (Kind IN (N'signed', N'audit')),
  Status        NVARCHAR(10) NOT NULL CONSTRAINT DF_ContractEmailDeliveries_Status DEFAULT N'pending'
                            CONSTRAINT CK_ContractEmailDeliveries_Status CHECK (Status IN (N'pending', N'sending', N'sent', N'failed')),
  AttemptCount  INT          NOT NULL CONSTRAINT DF_ContractEmailDeliveries_AttemptCount DEFAULT 0,
  LastAttemptAt DATETIME2(0) NULL,
  SentAt        DATETIME2(0) NULL,
  LastError     NVARCHAR(1000) NULL,
  CONSTRAINT PK_ContractEmailDeliveries PRIMARY KEY (ContractId, SignerOrder, Kind)
);
GO
