/*
  Migration 001 - email one-time passwords (OTP) for login and signup
  --------------------------------------------------------------------
  Run in SSMS against your database, or:  npm run db:migrate
  Safe to re-run.

  One row per OTP "challenge":
  - login:  created after the password is checked; verifying it issues the session token.
  - signup: holds the pending account (name, organisation, password hash) in PayloadJson;
            the user is only created once the email is verified.
  The code itself is never stored, only an HMAC-SHA256 hash of it.
*/

IF OBJECT_ID(N'eSign.EmailOtps', N'U') IS NULL
CREATE TABLE eSign.EmailOtps (
  Id           NVARCHAR(32)  NOT NULL CONSTRAINT PK_EmailOtps PRIMARY KEY,   -- challenge id given to the browser
  Email        NVARCHAR(320) NOT NULL,                                        -- lower-case
  Purpose      NVARCHAR(20)  NOT NULL CONSTRAINT CK_EmailOtps_Purpose CHECK (Purpose IN (N'login', N'signup')),
  UserId       NVARCHAR(32)  NULL CONSTRAINT FK_EmailOtps_Users REFERENCES eSign.Users (Id) ON DELETE CASCADE,
  CodeHash     NVARCHAR(64)  NOT NULL,
  PayloadJson  NVARCHAR(MAX) NULL CONSTRAINT CK_EmailOtps_Payload CHECK (PayloadJson IS NULL OR ISJSON(PayloadJson) = 1),
  Attempts     INT           NOT NULL CONSTRAINT DF_EmailOtps_Attempts DEFAULT 0,
  ResendCount  INT           NOT NULL CONSTRAINT DF_EmailOtps_ResendCount DEFAULT 0,
  ExpiresAt    DATETIME2(0)  NOT NULL,
  LastSentAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_EmailOtps_LastSentAt DEFAULT SYSUTCDATETIME(),
  ConsumedAt   DATETIME2(0)  NULL,
  IpAddress    NVARCHAR(64)  NULL,
  CreatedAt    DATETIME2(0)  NOT NULL CONSTRAINT DF_EmailOtps_CreatedAt DEFAULT SYSUTCDATETIME()
);
GO

/* Used to rate-limit how many codes one email can request */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmailOtps_Email_Created' AND object_id = OBJECT_ID(N'eSign.EmailOtps'))
  CREATE INDEX IX_EmailOtps_Email_Created ON eSign.EmailOtps (Email, CreatedAt DESC);
GO
