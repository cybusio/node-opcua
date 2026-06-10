// Regression test for https://github.com/node-opcua/node-opcua/issues/1520
//
// Some servers (e.g. the Eclipse Milo 1.0.x demo server) encode
// StructureDefinition.baseDataType with a namespace index local to the
// originating nodeset file instead of the index assigned in the server
// namespace table. The advertised baseDataType then does not exist in the
// server address space and the whole dataType used to fail to register,
// leaving values as OpaqueStructure.
import "should";
import { ExtraDataTypeManager } from "../source/extra_data_type_manager";
import { NodeId, resolveNodeId } from "node-opcua-nodeid";
import { StatusCodes } from "node-opcua-status-code";
import { AttributeIds, BrowseDirection } from "node-opcua-data-model";
import { DataTypeFactory, getStandardDataTypeFactory } from "node-opcua-factory";
import { DataTypeIds, ObjectIds, VariableIds } from "node-opcua-constants";
const { StructureDefinition, StructureField } = require("node-opcua-types");

enum NodeClass {
    Object = 1,
    Variable = 2,
    DataType = 64
}

interface MockNode {
    nodeId: NodeId;
    browseName: string;
    nodeClass: number;
    attributes: Map<number, any>;
    references: { referenceTypeId: NodeId; nodeId: NodeId; isForward: boolean; browseName: string; nodeClass: number }[];
}

class MockAddressSpace {
    nodes: Map<string, MockNode> = new Map();

    constructor() {
        // Essential nodes for node-opcua-pseudo-session and browseAll
        this.addNode({ nodeId: resolveNodeId(VariableIds.Server_ServerCapabilities_MaxBrowseContinuationPoints), browseName: "MaxBrowseContinuationPoints", nodeClass: NodeClass.Variable });
        this.addNode({ nodeId: resolveNodeId(VariableIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse), browseName: "MaxNodesPerBrowse", nodeClass: NodeClass.Variable });
        this.addNode({ nodeId: resolveNodeId(VariableIds.Server_ServerCapabilities_ServerProfileArray), browseName: "ServerProfileArray", nodeClass: NodeClass.Variable });
        for (const nid of [
            VariableIds.Server_ServerCapabilities_MaxBrowseContinuationPoints,
            VariableIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse,
            VariableIds.Server_ServerCapabilities_ServerProfileArray
        ]) {
            const node = this.nodes.get(resolveNodeId(nid).toString())!;
            node.attributes.set(AttributeIds.DataType, resolveNodeId(DataTypeIds.UInt32));
            node.attributes.set(AttributeIds.Value, nid === VariableIds.Server_ServerCapabilities_ServerProfileArray ? [] : 0);
        }
        this.addNode({ nodeId: resolveNodeId(ObjectIds.OPCBinarySchema_TypeSystem), browseName: "OPCBinarySchema", nodeClass: NodeClass.Object });

        this.addNode({ nodeId: resolveNodeId(DataTypeIds.BaseDataType), browseName: "BaseDataType", nodeClass: NodeClass.DataType });
        this.addNode({ nodeId: resolveNodeId(DataTypeIds.Structure), browseName: "Structure", nodeClass: NodeClass.DataType });
        this.addReference(resolveNodeId(DataTypeIds.BaseDataType), "HasSubtype", resolveNodeId(DataTypeIds.Structure));
        const basicTypes = [
            { id: 1, name: "Boolean" },
            { id: 4, name: "Int16" },
            { id: 7, name: "UInt32" },
            { id: 11, name: "Double" },
            { id: 12, name: "String" }
        ];
        for (const type of basicTypes) {
            const nid = new NodeId(NodeId.NodeIdType.NUMERIC, type.id, 0);
            this.addNode({ nodeId: nid, browseName: type.name, nodeClass: NodeClass.DataType });
            this.addReference(resolveNodeId(DataTypeIds.BaseDataType), "HasSubtype", nid);
        }
    }

    addNode(node: { nodeId: NodeId; browseName: string; nodeClass?: number }): MockNode {
        const mockNode: MockNode = {
            nodeId: node.nodeId,
            browseName: node.browseName,
            nodeClass: node.nodeClass || NodeClass.DataType,
            attributes: new Map(),
            references: []
        };
        mockNode.attributes.set(AttributeIds.BrowseName, { name: node.browseName });
        if (mockNode.nodeClass === NodeClass.DataType) {
            mockNode.attributes.set(AttributeIds.IsAbstract, false);
            const def = new StructureDefinition();
            def.baseDataType = resolveNodeId(DataTypeIds.Structure);
            mockNode.attributes.set(AttributeIds.DataTypeDefinition, def);
        }
        this.nodes.set(node.nodeId.toString(), mockNode);
        return mockNode;
    }

    addReference(source: NodeId, referenceTypeId: NodeId | string, target: NodeId, isForward = true) {
        const s = this.nodes.get(source.toString());
        const t = this.nodes.get(target.toString());
        const refId = typeof referenceTypeId === "string" ? resolveNodeId(referenceTypeId) : referenceTypeId;
        if (s && t) {
            s.references.push({ referenceTypeId: refId, nodeId: target, isForward, browseName: t.browseName, nodeClass: t.nodeClass });
            t.references.push({ referenceTypeId: refId, nodeId: source, isForward: !isForward, browseName: s.browseName, nodeClass: s.nodeClass });
        }
    }

    findNode(nodeId: NodeId): MockNode | undefined {
        const key = nodeId.toString();
        let node = this.nodes.get(key);
        if (!node) {
            if (key.startsWith("i=")) {
                node = this.nodes.get("ns=0;" + key);
            } else if (!key.startsWith("ns=")) {
                node = this.nodes.get("i=" + key) || this.nodes.get("ns=0;i=" + key);
            }
        }
        return node;
    }

    read(nodeId: NodeId, attributeId: AttributeIds): any {
        if (!nodeId) return { statusCode: StatusCodes.BadNodeIdInvalid, value: null };
        const node = this.findNode(nodeId);
        if (!node) return { statusCode: StatusCodes.BadNodeIdUnknown, value: null };
        let value = node.attributes.get(attributeId);
        if (value === undefined) {
            if (attributeId === AttributeIds.BrowseName) {
                value = { name: node.browseName };
            } else {
                return { statusCode: StatusCodes.BadAttributeIdInvalid, value: null };
            }
        }
        return { statusCode: StatusCodes.Good, value };
    }

    browse(nodeId: NodeId, options: any): any {
        if (!nodeId) return { statusCode: StatusCodes.BadNodeIdInvalid, references: [] };
        const node = this.findNode(nodeId);
        if (!node) return { statusCode: StatusCodes.BadNodeIdUnknown, references: [] };
        const refTypeId = options.referenceTypeId
            ? typeof options.referenceTypeId === "string"
                ? resolveNodeId(options.referenceTypeId)
                : options.referenceTypeId
            : null;
        let filteredRefs = node.references;
        if (refTypeId) {
            filteredRefs = filteredRefs.filter((r) => r.referenceTypeId.toString() === refTypeId.toString());
        }
        if (options.browseDirection === BrowseDirection.Forward) {
            filteredRefs = filteredRefs.filter((r) => r.isForward);
        } else if (options.browseDirection === BrowseDirection.Inverse) {
            filteredRefs = filteredRefs.filter((r) => !r.isForward);
        }
        return {
            references: filteredRefs.map((r) => ({
                nodeId: r.nodeId,
                browseName: { name: r.browseName },
                referenceTypeId: r.referenceTypeId,
                isForward: r.isForward,
                nodeClass: r.nodeClass
            })),
            statusCode: StatusCodes.Good
        };
    }
}

function createMockSession(addressSpace: MockAddressSpace) {
    return {
        read: async (nodesToRead: any) => {
            const results = (Array.isArray(nodesToRead) ? nodesToRead : [nodesToRead]).map((n) => {
                const res = addressSpace.read(n.nodeId, n.attributeId);
                return {
                    statusCode: res.statusCode,
                    value:
                        res.value !== null && res.value !== undefined
                            ? { value: res.value, toString: () => "Variant(" + JSON.stringify(res.value) + ")" }
                            : undefined
                };
            });
            return Array.isArray(nodesToRead) ? results : results[0];
        },
        browse: async (nodesToBrowse: any) => {
            const results = (Array.isArray(nodesToBrowse) ? nodesToBrowse : [nodesToBrowse]).map((nodeToBrowse) => {
                const res = addressSpace.browse(nodeToBrowse.nodeId, nodeToBrowse);
                return { statusCode: res.statusCode, references: res.references };
            });
            return Array.isArray(nodesToBrowse) ? results : results[0];
        },
        translateBrowsePath: async () => {
            return { statusCode: StatusCodes.BadNoMatch, targets: [] };
        }
    };
}

describe("repair invalid StructureDefinition.baseDataType (issue #1520)", () => {
    // mimic the Eclipse Milo demo server: the dataTypes live in namespace 3,
    // but baseDataType inside the DataTypeDefinition is (wrongly) advertised in namespace 1
    const namespaceArray = [
        "http://opcfoundation.org/UA/",
        "urn:server",
        "urn:demo",
        "https://github.com/digitalpetri/DataTypeTest"
    ];
    const testNamespaceIndex = 3;

    function field(name: string, dataType: NodeId | number) {
        return new StructureField({
            name,
            dataType: typeof dataType === "number" ? new NodeId(NodeId.NodeIdType.NUMERIC, dataType, 0) : dataType,
            valueRank: -1,
            isOptional: false
        });
    }

    function makeAddressSpaceWithBogusBaseDataType() {
        const addressSpace = new MockAddressSpace();

        const abstractTestType = new NodeId(NodeId.NodeIdType.NUMERIC, 3003, testNamespaceIndex);
        const concreteTestType = new NodeId(NodeId.NodeIdType.NUMERIC, 3006, testNamespaceIndex);
        const concreteEncoding = new NodeId(NodeId.NodeIdType.NUMERIC, 5001, testNamespaceIndex);

        const abstractNode = addressSpace.addNode({
            nodeId: abstractTestType,
            browseName: "AbstractTestType",
            nodeClass: NodeClass.DataType
        });
        abstractNode.attributes.set(AttributeIds.IsAbstract, true);
        const abstractDefinition = new StructureDefinition({
            baseDataType: resolveNodeId(DataTypeIds.Structure),
            fields: [field("Int16Field", 4), field("DoubleField", 11), field("StringField", 12)]
        });
        abstractNode.attributes.set(AttributeIds.DataTypeDefinition, abstractDefinition);
        addressSpace.addReference(resolveNodeId(DataTypeIds.Structure), "HasSubtype", abstractTestType);

        const concreteNode = addressSpace.addNode({
            nodeId: concreteTestType,
            browseName: "ConcreteTestType",
            nodeClass: NodeClass.DataType
        });
        // the defect: baseDataType advertised with the wrong namespace index (1 instead of 3),
        // pointing to a node that does not exist in the server address space.
        // The fields array contains all inherited fields, as required by the spec.
        const concreteDefinition = new StructureDefinition({
            baseDataType: new NodeId(NodeId.NodeIdType.NUMERIC, 3003, 1),
            defaultEncodingId: concreteEncoding,
            fields: [
                field("Int16Field", 4),
                field("DoubleField", 11),
                field("StringField", 12),
                field("BooleanField", 1)
            ]
        });
        concreteNode.attributes.set(AttributeIds.DataTypeDefinition, concreteDefinition);
        addressSpace.addReference(abstractTestType, "HasSubtype", concreteTestType);

        const encodingNode = addressSpace.addNode({
            nodeId: concreteEncoding,
            browseName: "Default Binary",
            nodeClass: NodeClass.Object
        });
        encodingNode.attributes.set(AttributeIds.IsAbstract, false);
        addressSpace.addReference(concreteTestType, "HasEncoding", encodingNode.nodeId);

        return { addressSpace, abstractTestType, concreteTestType, concreteEncoding };
    }

    it("should register a dataType whose advertised baseDataType does not exist, using the browsed superType", async () => {
        const { addressSpace, concreteTestType } = makeAddressSpaceWithBogusBaseDataType();

        const dataTypeManager = new ExtraDataTypeManager();
        dataTypeManager.setNamespaceArray(namespaceArray);
        const testFactory = new DataTypeFactory([getStandardDataTypeFactory()]);
        dataTypeManager.registerDataTypeFactory(testNamespaceIndex, testFactory);

        const mockSession = createMockSession(addressSpace);
        dataTypeManager.setSession(mockSession as any);

        const info = await dataTypeManager.getStructureInfoForDataTypeAsync(concreteTestType);
        info.schema.name.should.eql("ConcreteTestType");
        // inheritance must be repaired from the inverse HasSubtype reference
        info.schema.baseType.should.eql("AbstractTestType");
        // the four fields must be available (3 inherited + 1 own)
        const Constructor = info.constructor!;
        const instance = new Constructor({
            int16Field: 42,
            doubleField: 3.14,
            stringField: "hello",
            booleanField: true
        });
        instance.int16Field.should.eql(42);
        instance.doubleField.should.eql(3.14);
        instance.stringField.should.eql("hello");
        instance.booleanField.should.eql(true);
    });

    it("should fall back to Structure when the superType cannot be browsed either", async () => {
        const { addressSpace, concreteTestType, abstractTestType } = makeAddressSpaceWithBogusBaseDataType();

        // sabotage the inverse HasSubtype reference as well
        const concreteNode = addressSpace.nodes.get(concreteTestType.toString())!;
        concreteNode.references = concreteNode.references.filter((r) => r.isForward);

        const dataTypeManager = new ExtraDataTypeManager();
        dataTypeManager.setNamespaceArray(namespaceArray);
        const testFactory = new DataTypeFactory([getStandardDataTypeFactory()]);
        dataTypeManager.registerDataTypeFactory(testNamespaceIndex, testFactory);

        const mockSession = createMockSession(addressSpace);
        dataTypeManager.setSession(mockSession as any);

        const info = await dataTypeManager.getStructureInfoForDataTypeAsync(concreteTestType);
        info.schema.name.should.eql("ConcreteTestType");
        // no inheritance available, but the type must still decode using the full fields array
        info.schema.baseType.should.eql("Structure");
        const Constructor = info.constructor!;
        const instance = new Constructor({
            int16Field: 42,
            booleanField: true
        });
        instance.int16Field.should.eql(42);
        instance.booleanField.should.eql(true);
    });

    it("should not alter a valid baseDataType", async () => {
        const { addressSpace, abstractTestType, concreteTestType } = makeAddressSpaceWithBogusBaseDataType();

        // make the advertised baseDataType valid
        const concreteNode = addressSpace.nodes.get(concreteTestType.toString())!;
        const definition = concreteNode.attributes.get(AttributeIds.DataTypeDefinition);
        definition.baseDataType = abstractTestType;

        const dataTypeManager = new ExtraDataTypeManager();
        dataTypeManager.setNamespaceArray(namespaceArray);
        const testFactory = new DataTypeFactory([getStandardDataTypeFactory()]);
        dataTypeManager.registerDataTypeFactory(testNamespaceIndex, testFactory);

        const mockSession = createMockSession(addressSpace);
        dataTypeManager.setSession(mockSession as any);

        const info = await dataTypeManager.getStructureInfoForDataTypeAsync(concreteTestType);
        info.schema.name.should.eql("ConcreteTestType");
        info.schema.baseType.should.eql("AbstractTestType");
    });
});
