import fs from 'fs';
import util from 'util';
import { EventEmitter } from 'events';
import C from './constants.js';
import { DicomMessage } from './Message.js';
import {
  ReservedField,
  HexField,
  UInt8Field,
  UInt16Field,
  UInt32Field,
  FilledField,
  BufferField,
  StringField } from './Field.js';
import { WriteStream } from './RWStream.js';
import { quitWithError } from './require.js';

const PDVHandle = function () {};

util.inherits(PDVHandle, EventEmitter);

const PDU = function () {
  this.fields = [];
  this.lengthBytes = 4;
};

PDU.prototype.length = function (fields) {
  let len = 0;

  fields.forEach(function (f) {
    len += f.getFields ? f.length(f.getFields()) : f.length();
  });

  return len;
};

PDU.prototype.is = function (type) {
  return this.type == type;
};

PDU.prototype.getFields = function (fields) {
  const len = this.lengthField(fields);

  fields.unshift(len);
  if (this.type !== null) {
    fields.unshift(new ReservedField());
    fields.unshift(new HexField(this.type));
  }

  return fields;
};

PDU.prototype.lengthField = function (fields) {
  if (this.lengthBytes == 4) {
    return new UInt32Field(this.length(fields));
  } else if (this.lengthBytes == 2) {
    return new UInt16Field(this.length(fields));
  }
  throw new Error('Invalid length bytes');

};

PDU.prototype.read = function (stream) {
  stream.read(C.TYPE_HEX, 1);
  const length = stream.read(C.TYPE_UINT32);

  this.readBytes(stream, length);
};

PDU.prototype.load = function (stream) {
  return PDU.createByStream(stream);
};

PDU.prototype.loadPDV = function (stream, length) {
  if (stream.end()) {
    return false;
  }
  let bytesRead = 0,
    pdvs = [];

  while (bytesRead < length) {
    let plength = stream.read(C.TYPE_UINT32),
      pdv = new PresentationDataValueItem();

    pdv.readBytes(stream, plength);
    bytesRead += plength + 4;

    pdvs.push(pdv);
  }

  return pdvs;
};

PDU.prototype.loadDicomMessage = function (stream, isCommand, isLast) {
  const message = DicomMessage.read(stream, isCommand, isLast);

  return message;
};

PDU.prototype.stream = function () {
  let stream = new WriteStream(),
    fields = this.getFields();

  // Writing to buffer
  fields.forEach(function (field) {
    field.write(stream);
  });

  return stream;
};

PDU.prototype.buffer = function () {
  return this.stream().buffer();
};

// TODO: Seems that we don't use it.
// Const interpretCommand = function (stream, isLast) {
//   ParseDicomMessage(stream);
// };

const mergePDVs = function (pdvs) {
  let merges = [],
    count = pdvs.length,
    i = 0;

  while (i < count) {
    console.log(pdvs[i].isLast, pdvs[i].type);
    if (!pdvs[i].isLast) {
      let j = i;

      while (!pdvs[j++].isLast && j < count) {
        pdvs[i].messageStream.concat(pdvs[j].messageStream);
      }
      merges.push(pdvs[i]);
      i = j;
    } else {
      merges.push(pdvs[i++]);
    }
  }

  return merges;
};

PDU.splitPData = function (pdata, maxSize) {
  const totalLength = pdata.totalLength();

  if (totalLength > maxSize) {
    // Split into chunks of pdatas
    let chunks = Math.floor(totalLength / maxSize),
      left = totalLength % maxSize;

    for (let i = 0; i < chunks; i++) {
      if (i == chunks - 1) {
        if (left < 6) {
          // Need to move some of the last chunk
        }
      }
    }
  } else {
    return [pdata];
  }
};

const readChunk = function (fd, bufferSize, slice, callback) {
  let buffer = Buffer.alloc(bufferSize),
    length = slice.length,
    start = slice.start;

  fs.read(fd, buffer, 0, length, start, function (err, bytesRead) {
    callback(err, bytesRead, buffer, slice);
  });
};

PDU.generatePDatas = function (context, bufferOrFile, maxSize, length, metaLength, callback) {
  let total,
    isFile = false;

  if (typeof bufferOrFile === 'string') {
    const stats = fs.statSync(bufferOrFile);

    total = stats.size;
    isFile = true;
  } else if (bufferOrFile instanceof Buffer) {
    total = length ? length : bufferOrFile.length;
  }
  const handler = new PDVHandle();

  let slices = [],
    start = metaLength + 144,
    index = 0;

  maxSize -= 6;
  while (start < total) {
    let sliceLength = maxSize,
      isLast = false;

    if (total - start < maxSize) {
      sliceLength = total - start;
      isLast = true;
    }
    slices.push({ start,
      length: sliceLength,
      isLast,
      index });
    start += sliceLength;
    index++;
  }

  if (isFile) {
    fs.open(bufferOrFile, 'r', function (err, fd) {
      if (err) {
        // Fs.closeSync(fd);
        return quitWithError(err, callback);
      } callback(null, handler);

      const after = function (err, bytesRead, buffer, slice) {
        if (err) {
          fs.closeSync(fd);
          handler.emit('error', err);

          return;
        }
        const pdv = new RawDataPDV(context, buffer, 0, slice.length, slice.isLast);

        handler.emit('pdv', pdv);

        if (slices.length < 1) {
          handler.emit('end');
          fs.closeSync(fd);
        } else {
          const next = slices.shift();

          readChunk(fd, maxSize, next, after);
        }
      };

      const sl = slices.shift();

      readChunk(fd, maxSize, sl, after);
    });
  } else {
    for (let i = 0; i < slices.length; i++) {
      const toSlice = slices[i];

      const buffer = bufferOrFile.slice(toSlice.start, toSlice.length);
      const pdv = new RawDataPDV(context, buffer, 0, toSlice.length, toSlice.isLast);

      handler.emit('pdv', pdv);

      if (i == slices.length - 1) {
        handler.emit('end');
      }
    }
  }

  return;
};

PDU.typeToString = function (type) {
  let pdu = null,
    typeNum = parseInt(type, 16);
  // Console.log("RECEIVED PDU-TYPE ", typeNum);

  switch (typeNum) {
  case 0x01 : pdu = 'ASSOCIATE-RQ'; break;
  case 0x02 : pdu = 'ASSOCIATE-AC'; break;
  case 0x04 : pdu = 'P-DATA-TF'; break;
  case 0x06 : pdu = 'RELEASE-RP'; break;
  case 0x07 : pdu = 'ASSOCIATE-ABORT'; break;
  case 0x10 : pdu = 'APPLICATION-CONTEXT-ITEM'; break;
  case 0x20 : pdu = 'PRESENTATION-CONTEXT-ITEM'; break;
  case 0x21 : pdu = 'PRESENTATION-CONTEXT-ITEM-AC'; break;
  case 0x30 : pdu = 'ABSTRACT-SYNTAX-ITEM'; break;
  case 0x40 : pdu = 'TRANSFER-SYNTAX-ITEM'; break;
  case 0x50 : pdu = 'USER-INFORMATION-ITEM'; break;
  case 0x51 : pdu = 'MAXIMUM-LENGTH-ITEM'; break;
  case 0x52 : pdu = 'IMPLEMENTATION-CLASS-UID-ITEM'; break;
  case 0x55 : pdu = 'IMPLEMENTATION-VERSION-NAME-ITEM'; break;
  default : break;
  }

  return pdu;
};

PDU.createByStream = function (stream) {
  if (stream.end()) {
    return null;
  }

  let pduType = stream.read(C.TYPE_HEX, 1),
    typeNum = parseInt(pduType, 16),
    pdu = null;
  // Console.log("RECEIVED PDU-TYPE ", pduType);

  switch (typeNum) {
  case 0x01 : pdu = new AssociateRQ(); break;
  case 0x02 : pdu = new AssociateAC(); break;
  case 0x04 : pdu = new PDataTF(); break;
  case 0x06 : pdu = new ReleaseRP(); break;
  case 0x07 : pdu = new AssociateAbort(); break;
  case 0x10 : pdu = new ApplicationContextItem(); break;
  case 0x20 : pdu = new PresentationContextItem(); break;
  case 0x21 : pdu = new PresentationContextItemAC(); break;
  case 0x30 : pdu = new AbstractSyntaxItem(); break;
  case 0x40 : pdu = new TransferSyntaxItem(); break;
  case 0x50 : pdu = new UserInformationItem(); break;
  case 0x51 : pdu = new MaximumLengthItem(); break;
  case 0x52 : pdu = new ImplementationClassUIDItem(); break;
  case 0x55 : pdu = new ImplementationVersionNameItem(); break;
  default : throw new Error(`Unrecoginized pdu type ${pduType}`);
  }
  if (pdu) {
    pdu.read(stream);
  }

  return pdu;
};

const nextItemIs = function (stream, pduType) {
  if (stream.end()) {
    return false;
  }

  const nextType = stream.read(C.TYPE_HEX, 1);

  stream.increment(-1);

  return pduType == nextType;
};

const AssociateRQ = function () {
  PDU.call(this);
  this.type = C.ITEM_TYPE_PDU_ASSOCIATE_RQ;
  this.protocolVersion = 1;
};

util.inherits(AssociateRQ, PDU);

AssociateRQ.prototype.setProtocolVersion = function (version) {
  this.protocolVersion = version;
};

AssociateRQ.prototype.setCalledAETitle = function (title) {
  this.calledAETitle = title;
};

AssociateRQ.prototype.setCallingAETitle = function (title) {
  this.callingAETitle = title;
};

AssociateRQ.prototype.setApplicationContextItem = function (item) {
  this.applicationContextItem = item;
};

AssociateRQ.prototype.setPresentationContextItems = function (items) {
  this.presentationContextItems = items;
};

AssociateRQ.prototype.setUserInformationItem = function (item) {
  this.userInformationItem = item;
};

AssociateRQ.prototype.allAccepted = function () {
  for (const i in this.presentationContextItems) {
    const item = this.presentationContextItems[i];

    if (!item.accepted()) {
      return false;
    }
  }

  return true;
};

AssociateRQ.prototype.getFields = function () {
  const f = [
    new UInt16Field(this.protocolVersion), new ReservedField(2),
    new FilledField(this.calledAETitle, 16), new FilledField(this.callingAETitle, 16),
    new ReservedField(32), this.applicationContextItem
  ];

  this.presentationContextItems.forEach(function (context) {
    f.push(context);
  });
  f.push(this.userInformationItem);

  return AssociateRQ.super_.prototype.getFields.call(this, f);
};

AssociateRQ.prototype.readBytes = function (stream, length) {
  this.type = C.ITEM_TYPE_PDU_ASSOCIATE_RQ;
  const version = stream.read(C.TYPE_UINT16);

  this.setProtocolVersion(version);
  stream.increment(2);
  const calledAE = stream.read(C.TYPE_ASCII, 16);

  this.setCalledAETitle(calledAE);
  const callingAE = stream.read(C.TYPE_ASCII, 16);

  this.setCallingAETitle(callingAE);
  stream.increment(32);

  const appContext = this.load(stream);

  this.setApplicationContextItem(appContext);

  const presContexts = [];

  do {
    presContexts.push(this.load(stream));
  } while (nextItemIs(stream, C.ITEM_TYPE_PRESENTATION_CONTEXT));
  this.setPresentationContextItems(presContexts);

  const userItem = this.load(stream);

  this.setUserInformationItem(userItem);
};

AssociateRQ.prototype.buffer = function () {
  return AssociateRQ.super_.prototype.buffer.call(this);
};

const AssociateAC = function () {
  AssociateRQ.call(this);
};

util.inherits(AssociateAC, AssociateRQ);

AssociateAC.prototype.readBytes = function (stream, length) {
  this.type = C.ITEM_TYPE_PDU_ASSOCIATE_AC;
  const version = stream.read(C.TYPE_UINT16);

  this.setProtocolVersion(version);
  stream.increment(66);

  const appContext = this.load(stream);

  this.setApplicationContextItem(appContext);

  const presContexts = [];

  do {
    presContexts.push(this.load(stream));
  } while (nextItemIs(stream, C.ITEM_TYPE_PRESENTATION_CONTEXT_AC));
  this.setPresentationContextItems(presContexts);

  const userItem = this.load(stream);

  this.setUserInformationItem(userItem);
};

AssociateAC.prototype.getMaxSize = function () {
  let items = this.userInformationItem.userDataItems,
    length = items.length,
    size = null;

  for (let i = 0; i < length; i++) {
    if (items[i].is(C.ITEM_TYPE_MAXIMUM_LENGTH)) {
      size = items[i].maximumLengthReceived;
      break;
    }
  }

  return size;
};

const AssociateAbort = function () {
  this.type = C.ITEM_TYPE_PDU_AABORT;
  this.source = 1;
  this.reason = 0;
  PDU.call(this);
};

util.inherits(AssociateAbort, PDU);

AssociateAbort.prototype.setSource = function (src) {
  this.source = src;
};

AssociateAbort.prototype.setReason = function (reason) {
  this.reason = reason;
};

AssociateAbort.prototype.readBytes = function (stream, length) {
  stream.increment(2);

  const source = stream.read(C.TYPE_UINT8);

  this.setSource(source);

  const reason = stream.read(C.TYPE_UINT8);

  this.setReason(reason);
};

AssociateAbort.prototype.getFields = function () {
  return AssociateAbort.super_.prototype.getFields.call(this, [
    new ReservedField(), new ReservedField(),
    new UInt8Field(this.source), new UInt8Field(this.reason)
  ]);
};

const ReleaseRQ = function () {
  this.type = C.ITEM_TYPE_PDU_RELEASE_RQ;
  PDU.call(this);
};

util.inherits(ReleaseRQ, PDU);

ReleaseRQ.prototype.getFields = function () {
  return ReleaseRQ.super_.prototype.getFields.call(this, [new ReservedField(4)]);
};

const ReleaseRP = function () {
  this.type = C.ITEM_TYPE_PDU_RELEASE_RP;
  PDU.call(this);
};

util.inherits(ReleaseRP, PDU);

ReleaseRP.prototype.readBytes = function (stream, length) {
  stream.increment(4);
};

ReleaseRP.prototype.getFields = function () {
  return ReleaseRP.super_.prototype.getFields.call(this, [new ReservedField(4)]);
};

const PDataTF = function () {
  this.type = C.ITEM_TYPE_PDU_PDATA;
  this.presentationDataValueItems = [];
  PDU.call(this);
};

util.inherits(PDataTF, PDU);

PDataTF.prototype.setPresentationDataValueItems = function (items) {
  this.presentationDataValueItems = items ? items : [];
};

PDataTF.prototype.getFields = function () {
  const fields = this.presentationDataValueItems;

  return PDataTF.super_.prototype.getFields.call(this, fields);
};

PDataTF.prototype.totalLength = function () {
  const fields = this.presentationDataValueItems;

  return this.length(fields);
};

PDataTF.prototype.readBytes = function (stream, length) {
  const pdvs = this.loadPDV(stream, length);
  // Let merges = mergePDVs(pdvs);

  this.setPresentationDataValueItems(pdvs);
};

const Item = function () {
  PDU.call(this);
  this.lengthBytes = 2;
};

util.inherits(Item, PDU);

Item.prototype.read = function (stream) {
  stream.read(C.TYPE_HEX, 1);
  const length = stream.read(C.TYPE_UINT16);

  this.readBytes(stream, length);
};

Item.prototype.write = function (stream) {
  stream.concat(this.stream());
};

Item.prototype.getFields = function (fields) {
  return Item.super_.prototype.getFields.call(this, fields);
};

const PresentationDataValueItem = function (context) {
  this.type = null;
  this.isLast = true;
  this.dataFragment = null;
  this.contextId = context;
  this.messageStream = null;
  Item.call(this);

  this.lengthBytes = 4;
};

util.inherits(PresentationDataValueItem, Item);

PresentationDataValueItem.prototype.setContextId = function (id) {
  this.contextId = id;
};

PresentationDataValueItem.prototype.setFlag = function (flag) {
  this.flag = flag;
};

PresentationDataValueItem.prototype.setPresentationDataValue = function (pdv) {
  this.pdv = pdv;
};

PresentationDataValueItem.prototype.setMessage = function (msg) {
  this.dataFragment = msg;
};

PresentationDataValueItem.prototype.getMessage = function () {
  return this.dataFragment;
};

PresentationDataValueItem.prototype.readBytes = function (stream, length) {
  this.contextId = stream.read(C.TYPE_UINT8);
  const messageHeader = stream.read(C.TYPE_UINT8);

  this.isLast = messageHeader >> 1;
  this.type = messageHeader & 1 ? C.DATA_TYPE_COMMAND : C.DATA_TYPE_DATA;

  // Load dicom messages
  this.messageStream = stream.more(length - 2);
};

PresentationDataValueItem.prototype.getFields = function () {
  const fields = [new UInt8Field(this.contextId)];
  // Define header
  const messageHeader = (1 & this.dataFragment.type) | ((this.isLast ? 1 : 0) << 1);

  fields.push(new UInt8Field(messageHeader));

  fields.push(this.dataFragment);

  return PresentationDataValueItem.super_.prototype.getFields.call(this, fields);
};

const RawDataPDV = function (context, buffer, start, length, isLast) {
  this.type = null;
  this.isLast = isLast;
  this.dataFragmentBuffer = buffer;
  this.bufferStart = start;
  this.bufferLength = length;
  this.contextId = context;
  Item.call(this);

  this.lengthBytes = 4;
};

util.inherits(RawDataPDV, Item);

RawDataPDV.prototype.getFields = function () {
  const fields = [new UInt8Field(this.contextId)];
  const messageHeader = (this.isLast ? 1 : 0) << 1;

  fields.push(new UInt8Field(messageHeader));
  fields.push(new BufferField(this.dataFragmentBuffer, this.bufferStart, this.bufferLength));

  return RawDataPDV.super_.prototype.getFields.call(this, fields);
};

const ApplicationContextItem = function () {
  this.type = C.ITEM_TYPE_APPLICATION_CONTEXT;
  this.applicationContextName = C.APPLICATION_CONTEXT_NAME;
  Item.call(this);
};

util.inherits(ApplicationContextItem, Item);

ApplicationContextItem.prototype.setApplicationContextName = function (name) {
  this.applicationContextName = name;
};

ApplicationContextItem.prototype.getFields = function () {
  return ApplicationContextItem.super_.prototype.getFields.call(this, [new StringField(this.applicationContextName)]);
};

ApplicationContextItem.prototype.readBytes = function (stream, length) {
  const appContext = stream.read(C.TYPE_ASCII, length);

  this.setApplicationContextName(appContext);
};

ApplicationContextItem.prototype.buffer = function () {
  return ApplicationContextItem.super_.prototype.buffer.call(this);
};

const PresentationContextItem = function () {
  this.type = C.ITEM_TYPE_PRESENTATION_CONTEXT;
  Item.call(this);
};

util.inherits(PresentationContextItem, Item);

PresentationContextItem.prototype.setPresentationContextID = function (id) {
  this.presentationContextID = id;
};

PresentationContextItem.prototype.setAbstractSyntaxItem = function (item) {
  this.abstractSyntaxItem = item;
};

PresentationContextItem.prototype.setTransferSyntaxesItems = function (items) {
  this.transferSyntaxesItems = items;
};

PresentationContextItem.prototype.setResultReason = function (reason) {
  this.resultReason = reason;
};

PresentationContextItem.prototype.accepted = function () {
  return this.resultReason == 0;
};

PresentationContextItem.prototype.readBytes = function (stream, length) {
  const contextId = stream.read(C.TYPE_UINT8);

  this.setPresentationContextID(contextId);
  stream.increment(1);
  stream.increment(1);
  stream.increment(1);

  const abstractItem = this.load(stream);

  this.setAbstractSyntaxItem(abstractItem);

  const transContexts = [];

  do {
    transContexts.push(this.load(stream));
  } while (nextItemIs(stream, C.ITEM_TYPE_TRANSFER_CONTEXT));
  this.setTransferSyntaxesItems(transContexts);
};

PresentationContextItem.prototype.getFields = function () {
  const f = [
    new UInt8Field(this.presentationContextID),
    new ReservedField(), new ReservedField(), new ReservedField(), this.abstractSyntaxItem
  ];

  this.transferSyntaxesItems.forEach(function (syntaxItem) {
    f.push(syntaxItem);
  });

  return PresentationContextItem.super_.prototype.getFields.call(this, f);
};

PresentationContextItem.prototype.buffer = function () {
  return PresentationContextItem.super_.prototype.buffer.call(this);
};

const PresentationContextItemAC = function () {
  this.type = C.ITEM_TYPE_PRESENTATION_CONTEXT_AC;
  Item.call(this);
};

util.inherits(PresentationContextItemAC, PresentationContextItem);

PresentationContextItemAC.prototype.readBytes = function (stream, length) {
  const contextId = stream.read(C.TYPE_UINT8);

  this.setPresentationContextID(contextId);
  stream.increment(1);
  const resultReason = stream.read(C.TYPE_UINT8);

  this.setResultReason(resultReason);
  stream.increment(1);

  const transItem = this.load(stream);

  this.setTransferSyntaxesItems([transItem]);
};

const AbstractSyntaxItem = function () {
  this.type = C.ITEM_TYPE_ABSTRACT_CONTEXT;
  Item.call(this);
};

util.inherits(AbstractSyntaxItem, Item);

AbstractSyntaxItem.prototype.setAbstractSyntaxName = function (name) {
  this.abstractSyntaxName = name;
};

AbstractSyntaxItem.prototype.getFields = function () {
  return AbstractSyntaxItem.super_.prototype.getFields.call(this, [new StringField(this.abstractSyntaxName)]);
};

AbstractSyntaxItem.prototype.buffer = function () {
  return AbstractSyntaxItem.super_.prototype.buffer.call(this);
};

AbstractSyntaxItem.prototype.readBytes = function (stream, length) {
  const name = stream.read(C.TYPE_ASCII, length);

  this.setAbstractSyntaxName(name);
};

const TransferSyntaxItem = function () {
  this.type = C.ITEM_TYPE_TRANSFER_CONTEXT;
  Item.call(this);
};

util.inherits(TransferSyntaxItem, Item);

TransferSyntaxItem.prototype.setTransferSyntaxName = function (name) {
  this.transferSyntaxName = name;
};

TransferSyntaxItem.prototype.readBytes = function (stream, length) {
  const transfer = stream.read(C.TYPE_ASCII, length);

  this.setTransferSyntaxName(transfer);
};

TransferSyntaxItem.prototype.getFields = function () {
  return TransferSyntaxItem.super_.prototype.getFields.call(this, [new StringField(this.transferSyntaxName)]);
};

TransferSyntaxItem.prototype.buffer = function () {
  return TransferSyntaxItem.super_.prototype.buffer.call(this);
};

const UserInformationItem = function () {
  this.type = C.ITEM_TYPE_USER_INFORMATION;
  Item.call(this);
};

util.inherits(UserInformationItem, Item);

UserInformationItem.prototype.setUserDataItems = function (items) {
  this.userDataItems = items;
};

UserInformationItem.prototype.readBytes = function (stream, length) {
  const items = [];
  const pdu = this.load(stream);

  do {
    items.push(pdu);
  } while (pdu === this.load(stream));
  this.setUserDataItems(items);
};

UserInformationItem.prototype.getFields = function () {
  const f = [];

  this.userDataItems.forEach(function (userData) {
    f.push(userData);
  });

  return UserInformationItem.super_.prototype.getFields.call(this, f);
};

UserInformationItem.prototype.buffer = function () {
  return UserInformationItem.super_.prototype.buffer.call(this);
};

const ImplementationClassUIDItem = function () {
  this.type = C.ITEM_TYPE_IMPLEMENTATION_UID;
  Item.call(this);
};

util.inherits(ImplementationClassUIDItem, Item);

ImplementationClassUIDItem.prototype.setImplementationClassUID = function (id) {
  this.implementationClassUID = id;
};

ImplementationClassUIDItem.prototype.readBytes = function (stream, length) {
  const uid = stream.read(C.TYPE_ASCII, length);

  this.setImplementationClassUID(uid);
};

ImplementationClassUIDItem.prototype.getFields = function () {
  return ImplementationClassUIDItem.super_.prototype.getFields.call(this, [new StringField(this.implementationClassUID)]);
};

ImplementationClassUIDItem.prototype.buffer = function () {
  return ImplementationClassUIDItem.super_.prototype.buffer.call(this);
};

const ImplementationVersionNameItem = function () {
  this.type = C.ITEM_TYPE_IMPLEMENTATION_VERSION;
  Item.call(this);
};

util.inherits(ImplementationVersionNameItem, Item);

ImplementationVersionNameItem.prototype.setImplementationVersionName = function (name) {
  this.implementationVersionName = name;
};

ImplementationVersionNameItem.prototype.readBytes = function (stream, length) {
  const name = stream.read(C.TYPE_ASCII, length);

  this.setImplementationVersionName(name);
};

ImplementationVersionNameItem.prototype.getFields = function () {
  return ImplementationVersionNameItem.super_.prototype.getFields.call(this, [new StringField(this.implementationVersionName)]);
};

ImplementationVersionNameItem.prototype.buffer = function () {
  return ImplementationVersionNameItem.super_.prototype.buffer.call(this);
};

const MaximumLengthItem = function () {
  this.type = C.ITEM_TYPE_MAXIMUM_LENGTH;
  this.maximumLengthReceived = 32768;
  Item.call(this);
};

util.inherits(MaximumLengthItem, Item);

MaximumLengthItem.prototype.setMaximumLengthReceived = function (length) {
  this.maximumLengthReceived = length;
};

MaximumLengthItem.prototype.readBytes = function (stream, length) {
  const l = stream.read(C.TYPE_UINT32);

  this.setMaximumLengthReceived(l);
};

MaximumLengthItem.prototype.getFields = function () {
  return MaximumLengthItem.super_.prototype.getFields.call(this, [new UInt32Field(this.maximumLengthReceived)]);
};

MaximumLengthItem.prototype.buffer = function () {
  return MaximumLengthItem.super_.prototype.buffer.call(this);
};

export {
  PDU,
  AssociateAC,
  AssociateRQ,
  AssociateAbort,
  ReleaseRQ,
  ReleaseRP,
  PDataTF,
  ApplicationContextItem,
  PresentationContextItem,
  PresentationContextItemAC,
  PresentationDataValueItem,
  AbstractSyntaxItem,
  TransferSyntaxItem,
  UserInformationItem,
  ImplementationClassUIDItem,
  ImplementationVersionNameItem,
  MaximumLengthItem,
  mergePDVs
};
