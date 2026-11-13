import test from 'node:test';
import assert from 'node:assert/strict';
import {actionHttpError,actionDeliveryMessage} from '../plugin/companion-action-http.mjs';
test('missing route and proxy HTML retain useful HTTP error causes without exposing bodies',()=>{
 assert.equal(actionHttpError(404,{error:'Not found'}),'action-service-not-found');
 assert.equal(actionHttpError(503,{error:'companion-actions-unavailable'}),'action-service-unavailable');
 assert.equal(actionHttpError(413,null),'action-request-too-large');assert.equal(actionHttpError(502,'<html>private upstream text</html>'),'action-service-unavailable');
 assert.equal(actionHttpError(429,{}),'action-rate-limited');assert.equal(actionHttpError(401,{}),'action-auth-required');
 assert.equal(actionDeliveryMessage(actionHttpError(404,{})).includes('доставка не подтверждена'),true);
});
test('known server machine error formats survive and arbitrary error text is not displayed',()=>{
 assert.equal(actionHttpError(409,{error_code:'action-id-reused'}),'action-id-reused');assert.equal(actionHttpError(409,{error:'action-proposal-changed'}),'action-proposal-changed');
 assert.equal(actionHttpError(500,{error:'SQL password private-token'}),'action-service-unavailable');
});
