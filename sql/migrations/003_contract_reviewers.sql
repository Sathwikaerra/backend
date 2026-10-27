/*
  Migration 003 - reviewers
  -------------------------
  Run in SSMS against your database, or:  npm run db:migrate
  Safe to re-run.

  Reviewers are stored with the signers in ContractSigners, ahead of them in the order.
  A reviewer approves (Signed = 1, no signature image) or rejects (DeclinedAt) the document;
  signers are only invited once every reviewer has approved.
*/

IF COL_LENGTH(N'eSign.ContractSigners', N'Kind') IS NULL
  ALTER TABLE eSign.ContractSigners ADD Kind NVARCHAR(10) NOT NULL
    CONSTRAINT DF_ContractSigners_Kind DEFAULT N'signer'
    CONSTRAINT CK_ContractSigners_Kind CHECK (Kind IN (N'signer', N'reviewer'));
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'ReviewComment') IS NULL
  ALTER TABLE eSign.ContractSigners ADD ReviewComment NVARCHAR(1000) NULL;   -- optional note left when approving
GO
