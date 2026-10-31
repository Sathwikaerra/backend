/*
  Migration 005 - signing methods
  -------------------------------
  Run in SSMS against your database, or:  npm run db:migrate
  Safe to re-run.

  - ContractSigners.Methods: every signing method the workflow allows this signer (comma separated).
    Method keeps the first one, as before.
  - ContractSigners.SignedMethod / Verification / VerificationJson: the method actually used, a one-line
    summary of the identity check for the certificate, and its evidence (masked Aadhaar, OTP target,
    face photo, DSC certificate details).
  - SigningChallenges: one row per identity check a signer starts (OTP, biometric, DSC). Only the
    SHA-256 of an OTP is stored. A verified row is spent when the signer signs.
*/

IF COL_LENGTH(N'eSign.ContractSigners', N'Methods') IS NULL
  ALTER TABLE eSign.ContractSigners ADD Methods NVARCHAR(300) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'SignedMethod') IS NULL
  ALTER TABLE eSign.ContractSigners ADD SignedMethod NVARCHAR(40) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'Verification') IS NULL
  ALTER TABLE eSign.ContractSigners ADD Verification NVARCHAR(500) NULL;
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'VerificationJson') IS NULL
  ALTER TABLE eSign.ContractSigners ADD VerificationJson NVARCHAR(MAX) NULL;
GO
UPDATE eSign.ContractSigners SET Methods = Method WHERE Methods IS NULL AND Method IS NOT NULL;
GO

IF OBJECT_ID(N'eSign.SigningChallenges', N'U') IS NULL
CREATE TABLE eSign.SigningChallenges (
  Id           NVARCHAR(32)   NOT NULL CONSTRAINT PK_SigningChallenges PRIMARY KEY,
  ContractId   NVARCHAR(32)   NOT NULL CONSTRAINT FK_SigningChallenges_Contracts REFERENCES eSign.Contracts (Id) ON DELETE CASCADE,
  SignerOrder  INT            NOT NULL,
  Method       NVARCHAR(40)   NOT NULL,
  CodeHash     NVARCHAR(64)   NULL,      -- OTP methods only
  Target       NVARCHAR(200)  NULL,      -- where the code went / which Aadhaar (masked)
  DetailJson   NVARCHAR(MAX)  NULL,
  Attempts     INT            NOT NULL CONSTRAINT DF_SigningChallenges_Attempts DEFAULT 0,
  CreatedAt    DATETIME2(0)   NOT NULL CONSTRAINT DF_SigningChallenges_CreatedAt DEFAULT SYSUTCDATETIME(),
  ExpiresAt    DATETIME2(0)   NOT NULL,
  VerifiedAt   DATETIME2(0)   NULL,
  UsedAt       DATETIME2(0)   NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SigningChallenges_Signer' AND object_id = OBJECT_ID(N'eSign.SigningChallenges'))
  CREATE INDEX IX_SigningChallenges_Signer ON eSign.SigningChallenges (ContractId, SignerOrder, CreatedAt);
GO
