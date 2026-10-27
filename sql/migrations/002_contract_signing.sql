/*
  Migration 002 - signing contracts
  ---------------------------------
  Run in SSMS against your database, or:  npm run db:migrate
  Safe to re-run.

  - Contracts keep a snapshot of the workflow they were started from (signing order,
    signer roles, signature boxes) so editing the workflow later never changes a sent contract.
  - ContractDocuments holds the PDF the signers saw ('original') and the final signed PDF ('signed').
  - ContractSigners gets the private signing-link token (only its SHA-256 hash is stored),
    the adopted signature image and the evidence captured when signing.
  - ContractEvents is the audit trail printed on the certificate page of the signed PDF.
*/

/* ---------- Contracts: snapshot columns + 'declined' status ---------- */
IF COL_LENGTH(N'eSign.Contracts', N'SigningMethod') IS NULL
  ALTER TABLE eSign.Contracts ADD SigningMethod NVARCHAR(20) NOT NULL CONSTRAINT DF_Contracts_SigningMethod DEFAULT N'sequential';
GO
IF COL_LENGTH(N'eSign.Contracts', N'ParticipantsJson') IS NULL
  ALTER TABLE eSign.Contracts ADD ParticipantsJson NVARCHAR(MAX) NULL CONSTRAINT CK_Contracts_ParticipantsJson CHECK (ParticipantsJson IS NULL OR ISJSON(ParticipantsJson) = 1);
GO
IF COL_LENGTH(N'eSign.Contracts', N'BoxesJson') IS NULL
  ALTER TABLE eSign.Contracts ADD BoxesJson NVARCHAR(MAX) NULL CONSTRAINT CK_Contracts_BoxesJson CHECK (BoxesJson IS NULL OR ISJSON(BoxesJson) = 1);
GO
IF COL_LENGTH(N'eSign.Contracts', N'EmailSubject') IS NULL
  ALTER TABLE eSign.Contracts ADD EmailSubject NVARCHAR(300) NULL;
GO
IF COL_LENGTH(N'eSign.Contracts', N'CancelledAt') IS NULL
  ALTER TABLE eSign.Contracts ADD CancelledAt DATETIME2(0) NULL;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Contracts_Status' AND definition NOT LIKE N'%declined%')
  ALTER TABLE eSign.Contracts DROP CONSTRAINT CK_Contracts_Status;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Contracts_Status')
  ALTER TABLE eSign.Contracts ADD CONSTRAINT CK_Contracts_Status CHECK (Status IN (N'incomplete', N'completed', N'declined', N'cancelled'));
GO

/* ---------- ContractSigners: signing link + signature evidence ---------- */
IF COL_LENGTH(N'eSign.ContractSigners', N'RoleId') IS NULL
  ALTER TABLE eSign.ContractSigners ADD RoleId NVARCHAR(64) NULL;            -- participant id in the workflow (owner of the boxes)
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'TokenHash') IS NULL
  ALTER TABLE eSign.ContractSigners ADD TokenHash NVARCHAR(64) NULL;         -- SHA-256 of the signing-link token
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'InvitedAt') IS NULL
  ALTER TABLE eSign.ContractSigners ADD InvitedAt DATETIME2(0) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'ViewedAt') IS NULL
  ALTER TABLE eSign.ContractSigners ADD ViewedAt DATETIME2(0) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'DeclinedAt') IS NULL
  ALTER TABLE eSign.ContractSigners ADD DeclinedAt DATETIME2(0) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'DeclineReason') IS NULL
  ALTER TABLE eSign.ContractSigners ADD DeclineReason NVARCHAR(1000) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'SignatureType') IS NULL
  ALTER TABLE eSign.ContractSigners ADD SignatureType NVARCHAR(10) NULL;     -- draw | type
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'SignatureImage') IS NULL
  ALTER TABLE eSign.ContractSigners ADD SignatureImage NVARCHAR(MAX) NULL;   -- PNG data URL
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'SignedIp') IS NULL
  ALTER TABLE eSign.ContractSigners ADD SignedIp NVARCHAR(64) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'SignedUserAgent') IS NULL
  ALTER TABLE eSign.ContractSigners ADD SignedUserAgent NVARCHAR(400) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_ContractSigners_TokenHash' AND object_id = OBJECT_ID(N'eSign.ContractSigners'))
  CREATE UNIQUE INDEX UX_ContractSigners_TokenHash ON eSign.ContractSigners (TokenHash) WHERE TokenHash IS NOT NULL;
GO

/* ---------- The original and the signed PDF of each contract ---------- */
IF OBJECT_ID(N'eSign.ContractDocuments', N'U') IS NULL
CREATE TABLE eSign.ContractDocuments (
  ContractId   NVARCHAR(32)   NOT NULL CONSTRAINT FK_ContractDocuments_Contracts REFERENCES eSign.Contracts (Id) ON DELETE CASCADE,
  Kind         NVARCHAR(10)   NOT NULL CONSTRAINT CK_ContractDocuments_Kind CHECK (Kind IN (N'original', N'signed')),
  FileName     NVARCHAR(260)  NOT NULL,
  SizeBytes    INT            NOT NULL,
  Sha256       NVARCHAR(64)   NOT NULL,
  Data         VARBINARY(MAX) NOT NULL,
  CreatedAt    DATETIME2(0)   NOT NULL CONSTRAINT DF_ContractDocuments_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_ContractDocuments PRIMARY KEY (ContractId, Kind)
);
GO

/* ---------- Audit trail ---------- */
IF OBJECT_ID(N'eSign.ContractEvents', N'U') IS NULL
CREATE TABLE eSign.ContractEvents (
  Id           INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_ContractEvents PRIMARY KEY,
  ContractId   NVARCHAR(32)   NOT NULL CONSTRAINT FK_ContractEvents_Contracts REFERENCES eSign.Contracts (Id) ON DELETE CASCADE,
  SignerOrder  INT            NULL,
  Event        NVARCHAR(30)   NOT NULL,   -- created, invited, viewed, signed, declined, completed, cancelled, reminded
  Detail       NVARCHAR(500)  NULL,
  IpAddress    NVARCHAR(64)   NULL,
  CreatedAt    DATETIME2(3)   NOT NULL CONSTRAINT DF_ContractEvents_CreatedAt DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ContractEvents_Contract' AND object_id = OBJECT_ID(N'eSign.ContractEvents'))
  CREATE INDEX IX_ContractEvents_Contract ON eSign.ContractEvents (ContractId, CreatedAt);
GO
