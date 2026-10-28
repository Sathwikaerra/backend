/*
  Migration 004 - public API and webhooks
  ---------------------------------------
  Run in SSMS against your database, or:  npm run db:migrate
  Safe to re-run.

  - ApiKeys: keys other systems use to call /api/v1. Only the SHA-256 of a key is stored;
    the key itself is shown once when it is created.
  - Webhooks: one URL per organisation that receives contract events, signed with its secret.
  - WebhookDeliveries: what was sent and how the receiver answered (for the Developers page).
  - Contracts.Source / ExternalRef / Notify: where a contract came from, the caller's own reference,
    and whether signing links are emailed by us ('email') or delivered by the caller ('none').
  - ContractSigners.Phone: optional, passed through the API.
*/

IF OBJECT_ID(N'eSign.ApiKeys', N'U') IS NULL
CREATE TABLE eSign.ApiKeys (
  Id              NVARCHAR(32)   NOT NULL CONSTRAINT PK_ApiKeys PRIMARY KEY,
  OrganisationId  NVARCHAR(32)   NOT NULL CONSTRAINT FK_ApiKeys_Organisations REFERENCES eSign.Organisations (Id) ON DELETE CASCADE,
  Name            NVARCHAR(100)  NOT NULL,
  Prefix          NVARCHAR(20)   NOT NULL,   -- start of the key, shown so people can tell keys apart
  KeyHash         NVARCHAR(64)   NOT NULL,
  CreatedBy       NVARCHAR(32)   NULL,
  CreatedAt       DATETIME2(0)   NOT NULL CONSTRAINT DF_ApiKeys_CreatedAt DEFAULT SYSUTCDATETIME(),
  LastUsedAt      DATETIME2(0)   NULL,
  RevokedAt       DATETIME2(0)   NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_ApiKeys_KeyHash' AND object_id = OBJECT_ID(N'eSign.ApiKeys'))
  CREATE UNIQUE INDEX UX_ApiKeys_KeyHash ON eSign.ApiKeys (KeyHash);
GO

IF OBJECT_ID(N'eSign.Webhooks', N'U') IS NULL
CREATE TABLE eSign.Webhooks (
  OrganisationId  NVARCHAR(32)   NOT NULL CONSTRAINT PK_Webhooks PRIMARY KEY
                                 CONSTRAINT FK_Webhooks_Organisations REFERENCES eSign.Organisations (Id) ON DELETE CASCADE,
  Url             NVARCHAR(500)  NOT NULL,
  Secret          NVARCHAR(100)  NOT NULL,   -- HMAC key for the X-Esign-Signature header
  Enabled         BIT            NOT NULL CONSTRAINT DF_Webhooks_Enabled DEFAULT 1,
  UpdatedAt       DATETIME2(0)   NOT NULL CONSTRAINT DF_Webhooks_UpdatedAt DEFAULT SYSUTCDATETIME()
);
GO

IF OBJECT_ID(N'eSign.WebhookDeliveries', N'U') IS NULL
CREATE TABLE eSign.WebhookDeliveries (
  Id              NVARCHAR(32)   NOT NULL CONSTRAINT PK_WebhookDeliveries PRIMARY KEY,
  OrganisationId  NVARCHAR(32)   NOT NULL CONSTRAINT FK_WebhookDeliveries_Organisations REFERENCES eSign.Organisations (Id) ON DELETE CASCADE,
  ContractId      NVARCHAR(32)   NULL,
  Event           NVARCHAR(30)   NOT NULL,
  Url             NVARCHAR(500)  NOT NULL,
  Attempts        INT            NOT NULL CONSTRAINT DF_WebhookDeliveries_Attempts DEFAULT 0,
  StatusCode      INT            NULL,
  Error           NVARCHAR(400)  NULL,
  CreatedAt       DATETIME2(3)   NOT NULL CONSTRAINT DF_WebhookDeliveries_CreatedAt DEFAULT SYSUTCDATETIME(),
  DeliveredAt     DATETIME2(3)   NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_WebhookDeliveries_Org' AND object_id = OBJECT_ID(N'eSign.WebhookDeliveries'))
  CREATE INDEX IX_WebhookDeliveries_Org ON eSign.WebhookDeliveries (OrganisationId, CreatedAt);
GO

IF COL_LENGTH(N'eSign.Contracts', N'Source') IS NULL
  ALTER TABLE eSign.Contracts ADD Source NVARCHAR(10) NOT NULL CONSTRAINT DF_Contracts_Source DEFAULT N'app';   -- app | api
GO
IF COL_LENGTH(N'eSign.Contracts', N'ExternalRef') IS NULL
  ALTER TABLE eSign.Contracts ADD ExternalRef NVARCHAR(100) NULL;   -- the API caller's own id for this contract
GO
IF COL_LENGTH(N'eSign.Contracts', N'Notify') IS NULL
  ALTER TABLE eSign.Contracts ADD Notify NVARCHAR(10) NOT NULL CONSTRAINT DF_Contracts_Notify DEFAULT N'email';  -- email | none
GO
IF COL_LENGTH(N'eSign.ContractSigners', N'Phone') IS NULL
  ALTER TABLE eSign.ContractSigners ADD Phone NVARCHAR(20) NULL;
GO
