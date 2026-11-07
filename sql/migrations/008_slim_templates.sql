/*
  Migration 008 - keep templates limited to document content and page setup
  --------------------------------------------------------------------------
  Run in SSMS against your database, or: npm run db:migrate
  Safe to re-run.

  Workflow signing configuration and contract snapshots are stored separately.
*/

IF OBJECT_ID(N'eSign.Templates', N'U') IS NULL
  THROW 50000, 'eSign.Templates must exist before migration 008 can run.', 1;
GO

DECLARE @tableId INT = OBJECT_ID(N'eSign.Templates', N'U');
DECLARE @constraintName SYSNAME;
DECLARE @sql NVARCHAR(MAX);

DECLARE template_constraint_cursor CURSOR LOCAL FAST_FORWARD FOR
  SELECT dc.name
  FROM sys.default_constraints dc
  INNER JOIN sys.columns c
    ON c.object_id = dc.parent_object_id
   AND c.column_id = dc.parent_column_id
  WHERE dc.parent_object_id = @tableId
    AND c.name IN (N'SigningMethod', N'StampingMethod', N'ExpiryValue', N'ExpiryUnit', N'ParticipantsJson')
  UNION
  SELECT cc.name
  FROM sys.check_constraints cc
  WHERE cc.parent_object_id = @tableId
    AND (
      cc.parent_column_id IN (
        SELECT c.column_id
        FROM sys.columns c
        WHERE c.object_id = @tableId
          AND c.name IN (N'SigningMethod', N'StampingMethod', N'ExpiryValue', N'ExpiryUnit', N'ParticipantsJson')
      )
      OR cc.definition LIKE N'%SigningMethod%'
      OR cc.definition LIKE N'%StampingMethod%'
      OR cc.definition LIKE N'%ExpiryValue%'
      OR cc.definition LIKE N'%ExpiryUnit%'
      OR cc.definition LIKE N'%ParticipantsJson%'
    );

OPEN template_constraint_cursor;
FETCH NEXT FROM template_constraint_cursor INTO @constraintName;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @sql = N'ALTER TABLE eSign.Templates DROP CONSTRAINT ' + QUOTENAME(@constraintName) + N';';
  EXEC sp_executesql @sql;
  FETCH NEXT FROM template_constraint_cursor INTO @constraintName;
END;
CLOSE template_constraint_cursor;
DEALLOCATE template_constraint_cursor;

IF COL_LENGTH(N'eSign.Templates', N'SigningMethod') IS NOT NULL
  ALTER TABLE eSign.Templates DROP COLUMN SigningMethod;
IF COL_LENGTH(N'eSign.Templates', N'StampingMethod') IS NOT NULL
  ALTER TABLE eSign.Templates DROP COLUMN StampingMethod;
IF COL_LENGTH(N'eSign.Templates', N'ExpiryValue') IS NOT NULL
  ALTER TABLE eSign.Templates DROP COLUMN ExpiryValue;
IF COL_LENGTH(N'eSign.Templates', N'ExpiryUnit') IS NOT NULL
  ALTER TABLE eSign.Templates DROP COLUMN ExpiryUnit;
IF COL_LENGTH(N'eSign.Templates', N'ParticipantsJson') IS NOT NULL
  ALTER TABLE eSign.Templates DROP COLUMN ParticipantsJson;
GO
