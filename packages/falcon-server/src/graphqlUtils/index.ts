import {
  GraphQLType,
  GraphQLNamedType,
  GraphQLResolveInfo,
  GraphQLScalarType,
  GraphQLObjectType,
  GraphQLOutputType,
  isScalarType,
  isWrappingType,
  ResponsePath
} from 'graphql';

export * from './schema';

export const PATH_SEPARATOR: string = '.';
export const ID_FIELD_TYPE: string = 'ID';
export const TAG_SEPARATOR: string = ':';
export const PARENT_KEYWORD: string = '$parent';

/**
 * Generates a path-like string for the provided request
 * for `query { foo { bar } }` - it will generate `foo.bar` string
 * @param node Operation path object
 * @returns Generated operation path string
 */
export const getOperationPath = (node: ResponsePath): string => {
  const { key, prev } = node;
  const keys = [key];
  if (prev) {
    keys.unshift(getOperationPath(prev));
  }
  return keys.join(PATH_SEPARATOR);
};

/**
 * Extract "root" type from GQL field by getting "ofType" sub-type until it reaches the root field
 * @param type GQL Object type
 * @returns "root" object type
 */
export const getRootType = (type: GraphQLOutputType): GraphQLType => {
  const realType: GraphQLType = isWrappingType(type) ? type.ofType : type;
  return isWrappingType(realType) ? getRootType(realType as GraphQLOutputType) : realType;
};

declare interface GetFieldValueFn {
  (sourceValue: object, fieldName: string): undefined | object | string;
  (sourceValue: Array<object>, fieldName: string): undefined | object[] | string[];
}

/**
 * Extract a value by `fieldName` from the provided `sourceValue`
 * @param sourceValue Source object to get a field value from
 * @param fieldName Name of the field
 * @returns Value or list of values (in case of `sourceValue` is an array)
 */
export const getFieldValue: GetFieldValueFn = (sourceValue: object | Array<object>, fieldName: string) => {
  if (!sourceValue || !fieldName) {
    return undefined;
  }
  if (Array.isArray(sourceValue)) {
    return sourceValue.map(item => getFieldValue(item, fieldName));
  }

  return fieldName in sourceValue ? sourceValue[fieldName] : undefined;
};

/**
 * Find a field name with ID_FIELD_TYPE type
 * @param gqlType GQL Object Type
 * @returns Name of the field with
 */
export const findIdFieldName = (gqlType: GraphQLOutputType): string | undefined => {
  const rootType = getRootType(gqlType);
  const { name: objectTypeName } = rootType as GraphQLNamedType;

  if (isScalarType(gqlType)) {
    throw new Error(`Caching for "${objectTypeName}" scalar type is not supported yet`);
  }

  const fields = (rootType as GraphQLObjectType).getFields();

  return Object.keys(fields).find(fieldName => {
    const { [fieldName]: fieldType } = fields;
    const { name } = getRootType(fieldType.type) as GraphQLScalarType;
    return name === ID_FIELD_TYPE;
  });
};

/**
 * Generate tag names using `entityName` and `entityId`
 * @param entityName Entity Type name (like "Product")
 * @param entityId Entity ID or list of IDs (like: "1" or ["1", "2"])
 * @returns List of tag names (example: ["Product:1", "Product:2"])
 */
export const generateTagNames = (entityName: string, entityId: string | string[]): string[] => {
  if (!entityId) {
    return [];
  }
  const ids = Array.isArray(entityId) ? entityId.filter(element => element) : [entityId];
  return ids.map(id => `${entityName}${TAG_SEPARATOR}${id}`);
};

/**
 * Get a list of tags from the provided `sourceValue` using specified `fieldType` and `fieldPathSections` (for nested values)
 * @param sourceValue Source value to get tags from
 * @param fieldType GraphQL Field Type object
 * @param [fieldPathSections=[]] An optional field path sections (example: `["products", "items"]` which are created from a relative `products.items` field path)
 * that are going to be used to get tags from. If not passed or empty - tags will be received from `sourceValue` directly.
 * @param forceTypeName type name to force as a tag name
 * @returns {string[]} List of tag names
 */
export const getTagsForField = (
  sourceValue: object,
  fieldType: GraphQLOutputType,
  fieldPathSections: string[] = [],
  forceTypeName?: string
): string[] => {
  const rootType = getRootType(fieldType) as GraphQLObjectType;
  if (!fieldPathSections.length) {
    const { name: typeName } = rootType;
    return generateTagNames(forceTypeName || typeName, getFieldValue(sourceValue, findIdFieldName(fieldType)) as
      | string
      | string[]);
  }

  const [currentPath, ...restIdPath] = fieldPathSections;
  const fields = rootType.getFields();
  let { name: typeName } = rootType;
  let fieldValue = getFieldValue(sourceValue, currentPath);

  // Keep looking for nested ID path until it reaches the end node
  if (currentPath && restIdPath.length) {
    return getTagsForField(
      fieldValue as object,
      getRootType(fields[currentPath].type) as GraphQLOutputType,
      restIdPath
    );
  }
  if (Array.isArray(fieldValue)) {
    const currentType = getRootType(fields[currentPath].type);
    typeName = (currentType as GraphQLNamedType).name;
    const currentCacheIdFieldName = findIdFieldName(currentType as GraphQLOutputType);
    fieldValue = getFieldValue(fieldValue, currentCacheIdFieldName);
  }
  typeName = forceTypeName || typeName;

  return [typeName, ...generateTagNames(typeName, fieldValue as string)];
};

/**
 * Extract cache tags for the provided ID path and return a list of tags
 * @param idPath ID operation path string (like "$parent.items" or "items")
 * @param result Resolver result
 * @param info GraphQL info object
 * @param parent GraphQL parent object
 * @param forceTypeName type name to force as a tag name
 * @returns List of tags
 */
export const extractTagsForIdPath = (
  idPath: string,
  result: object,
  info: GraphQLResolveInfo,
  parent: object,
  forceTypeName?: string
): string[] => {
  const [rootPath, ...fieldPathSections] = idPath.split(PATH_SEPARATOR);
  const valueToCheck = rootPath === PARENT_KEYWORD ? parent : result;
  const typeToCheck = getRootType(rootPath === PARENT_KEYWORD ? info.parentType : info.returnType);
  if (rootPath !== PARENT_KEYWORD) {
    // Put first path section back to "fieldPathSections" for non-parent entries
    fieldPathSections.unshift(rootPath);
  }

  return getTagsForField(valueToCheck, typeToCheck as GraphQLOutputType, fieldPathSections, forceTypeName);
};
