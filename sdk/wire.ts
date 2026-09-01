/**
 * Trading WebSocket binary frames (`TradingWsBinaryFrame`).
 */

import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { ResponseMessageType } from './generated/gdx/common/v1/types_pb.js';
import {
  EncryptedEdgeRequestSchema,
  HpkeSetupSchema,
  HpkeSetupReplySchema,
  TradingWsBinaryFrameSchema,
  type EncryptedEdgeRequest,
  type EncryptedEdgeResponse,
  type HpkeSetup,
  type OrderHeader,
} from './generated/gdx/edge/v1/edge_pb.js';
import { WIRE_VERSION } from './hpke.js';

const RESPONSE_MESSAGE_TYPE_TO_WIRE: Record<number, string> = {
  [ResponseMessageType.ORDER_UPDATE]: 'order_update',
  [ResponseMessageType.SYSTEM_HEALTH]: 'system_health',
  [ResponseMessageType.ACK]: 'ack',
  [ResponseMessageType.OPEN_ORDERS_SNAPSHOT]: 'open_orders_snapshot',
  [ResponseMessageType.POSITIONS_SNAPSHOT]: 'positions_snapshot',
  [ResponseMessageType.BALANCE_AND_POSITION]: 'balance_and_position',
  [ResponseMessageType.ACCOUNT_MARGIN_UPDATE]: 'account_margin_update',
  [ResponseMessageType.MASS_QUOTE_ACK]: 'mass_quote_ack',
  [ResponseMessageType.BATCH_CANCEL_ACK]: 'batch_cancel_ack',
  [ResponseMessageType.BATCH_MODIFY_ACK]: 'batch_modify_ack',
  [ResponseMessageType.TPSL_UPDATE]: 'tpsl_update',
  [ResponseMessageType.LEVERAGE_SETTINGS]: 'leverage_settings',
  [ResponseMessageType.CANCEL_ALL_ACK]: 'cancel_all_ack',
  [ResponseMessageType.CLOSE_ALL_ACK]: 'close_all_ack',
  [ResponseMessageType.REVERSE_ACK]: 'reverse_ack',
  [ResponseMessageType.TPSL_ACK]: 'tpsl_ack',
};

export function encodeHpkeSetup(
  userUuid: Uint8Array,
  connId: number | bigint,
  encappedKey: Uint8Array,
): Uint8Array {
  const frame = create(TradingWsBinaryFrameSchema, {
    body: {
      case: 'hpkeSetup',
      value: create(HpkeSetupSchema, {
        userUuid,
        connId: BigInt(connId),
        encappedKey,
      }),
    },
  });
  return toBinary(TradingWsBinaryFrameSchema, frame);
}

export function encodeEncryptedOrder(req: EncryptedEdgeRequest): Uint8Array {
  const frame = create(TradingWsBinaryFrameSchema, {
    body: {
      case: 'encryptedOrder',
      value: req,
    },
  });
  return toBinary(TradingWsBinaryFrameSchema, frame);
}

export function encryptedOrderRequest(
  header: OrderHeader,
  encryptedBody: Uint8Array,
): EncryptedEdgeRequest {
  return create(EncryptedEdgeRequestSchema, {
    version: WIRE_VERSION,
    header,
    encryptedBody,
  });
}

export function encodeHpkeSetupReply(connId: number | bigint, established: boolean): Uint8Array {
  const frame = create(TradingWsBinaryFrameSchema, {
    body: {
      case: 'hpkeSetupReply',
      value: create(HpkeSetupReplySchema, {
        connId: BigInt(connId),
        established,
      }),
    },
  });
  return toBinary(TradingWsBinaryFrameSchema, frame);
}

export function encodeEncryptedPush(resp: EncryptedEdgeResponse): Uint8Array {
  const frame = create(TradingWsBinaryFrameSchema, {
    body: {
      case: 'encryptedPush',
      value: resp,
    },
  });
  return toBinary(TradingWsBinaryFrameSchema, frame);
}

export type DecodedBinary =
  | { kind: 'encrypted_push'; value: EncryptedEdgeResponse }
  | { kind: 'encrypted_order'; value: EncryptedEdgeRequest }
  | { kind: 'hpke_setup'; value: HpkeSetup }
  | { kind: 'hpke_setup_reply'; connId: string; established: boolean }
  | { kind: 'ignored' };

export function encryptedPushToJson(push: EncryptedEdgeResponse): Record<string, unknown> | null {
  const h = push.header;
  if (!h) return null;
  const messageType =
    RESPONSE_MESSAGE_TYPE_TO_WIRE[h.messageType] ?? 'unknown';
  const corrBytes = h.correlationId;
  let correlationId: string | null = null;
  if (corrBytes.length > 0) {
    const buf = new Uint8Array(16);
    const n = Math.min(corrBytes.length, 16);
    buf.set(corrBytes.subarray(corrBytes.length - n), 16 - n);
    let hex = '';
    for (const b of buf) hex += b.toString(16).padStart(2, '0');
    correlationId = hex;
  }
  return {
    type: 'encrypted_push',
    message_type: messageType,
    encrypted_body: Buffer.from(push.encryptedBody).toString('base64'),
    nonce: Number(h.nonce),
    fencing_epoch: Number(h.fencingEpoch),
    correlation_id: correlationId,
    session_seq: Number(h.sessionSeq),
    conn_id: h.connId.toString(),
    body_length: h.bodyLength,
  };
}

export function decodeBinaryFrame(bytes: Uint8Array): DecodedBinary {
  let frame;
  try {
    frame = fromBinary(TradingWsBinaryFrameSchema, bytes);
  } catch {
    return { kind: 'ignored' };
  }
  switch (frame.body.case) {
    case 'encryptedPush':
      return { kind: 'encrypted_push', value: frame.body.value };
    case 'hpkeSetupReply': {
      const r = frame.body.value;
      return {
        kind: 'hpke_setup_reply',
        connId: r.connId.toString(),
        established: r.established,
      };
    }
    case 'encryptedOrder':
      return { kind: 'encrypted_order', value: frame.body.value };
    case 'hpkeSetup':
      return { kind: 'hpke_setup', value: frame.body.value };
    default:
      return { kind: 'ignored' };
  }
}
