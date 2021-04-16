import { APIGatewayEvent, APIGatewayProxyResult, S3Event } from 'aws-lambda'
import apiResponses from 'src/requests/apiResponses'
import { S3Client } from '@aws-sdk/client-s3'
import axios from 'axios'

import {
  getTokenForMinting,
} from '../models/mysteryDropFunctions'
import { authenticate, getAuthenticationChallenge } from '../lib/auth'
import {
  DropMetadata,
  prepareS3ForUpload,
  processUploadedContent,
} from '../lib/upload'
import { getDropsView } from '../lib/drops'
import { preprocessContent } from 'src/lib/mint'

const MAX_ITEMS_IN_COLLECTION = 6

const client = new S3Client({ region: process.env.AWS_REGION })

/**
 * GET /sessions
 *
 * Returns a nonce given a public address
 * @method nonce
 * @param {String} event.queryStringParameter['PublicAddress']
 * @throws Returns 401 if the user is not found
 * @returns {Object} nonce for the user to sign
 */
export async function nonce(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  const parameters = event.queryStringParameters

  // todo input validation

  const publicAddress = parameters['PublicAddress']
  try {
    const nonce = await getAuthenticationChallenge(publicAddress)
    return apiResponses._200({ nonce })
  } catch (e) {
    return apiResponses._400({ error: e.message })
  }
}

/**
 * POST /sessions
 *
 * Returns a JWT, given a username and password.
 * @method login
 * @param {String} event.body.username
 * @param {String} event.body.password
 * @throws Returns 401 if the user is not found or password is invalid.
 * @returns {Object} jwt that expires in 5 mins
 */
export async function login(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  try {
    // todo input validation
    const { publicAddress, signature } = JSON.parse(event.body)

    const token = await authenticate(publicAddress, signature)
    return apiResponses._200({ token })
  } catch (e) {
    return apiResponses._400({ error: e.message })
  }
}

/**
 * OPTION /{proxy+}
 *
 * Returns proper CORS config
 */
export function defaultCORS(event: APIGatewayEvent): APIGatewayProxyResult {
  const response = {
    // Success response
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({}),
  }
  return response
}

/**
 * GET /helloAuth
 *
 * Returns a message given a valid auth header
 * @method helloAuth
 */
export async function helloAuth(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  console.log({ event })
  const user = event.requestContext.authorizer.lambda.user
  return apiResponses._200({ message: `Hello ${user} you are authenticated` })
}

/**
 * POST /initiateUpload
 *
 *
 * Returns a nonce given a public address
 * @method initiateUpload
 * @param {String} event.body.contentType
 * @param {String} event.body.title
 * @param {String} event.body.description
 * @throws Returns 401 if the user is not found
 * @returns {Object} Pre-signed URL for the user to upload their image
 */
export async function initiateUpload(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  console.log({ event })
  const user = event.requestContext.authorizer.lambda.user

  // TODO validate input matches the expected format - probably use zod
  const dropMetadata = JSON.parse(event.body || '{}') as DropMetadata

  try {
    // Make sure number of items matches length
    if (dropMetadata.numberOfItems != dropMetadata.content.length)
      throw new Error('Content length does not match number of items')

    if (dropMetadata.numberOfItems > MAX_ITEMS_IN_COLLECTION)
      throw new Error('Exceeds max number of items')

    const result = await prepareS3ForUpload({ ...dropMetadata, user }, client)

    return apiResponses._200({ result })
  } catch (e) {
    return apiResponses._400({ error: e.message })
  }
}

export async function s3ProcessUploadedPhoto(event: S3Event): Promise<void> {
  const s3Record = event.Records[0].s3
  await processUploadedContent(s3Record, client)
}

/**
 * GET /drops
 *
 *
 * Returns all drops for an authenticated user
 * @method getDrops
 * @throws Returns 401 if the user is not authorized
 * @returns {Object} Metadata for all user drops
 */
export async function getDrops(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  const user = event.requestContext.authorizer.lambda.user

  try {
    const drops = await getDropsView(user, client)

    return apiResponses._200({ drops })
  } catch (e) {
    return apiResponses._400({ error: e.message })
  }
}

export async function prepareForMinting(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  const parameters = event.queryStringParameters
  const user = event.requestContext.authorizer.lambda.user

  // todo input validation

  const dropId = parameters['dropId']
  const contentId = parameters['contentId']

  try {
    const tokenData = await preprocessContent(dropId, contentId, user, client)

    return apiResponses._200({ success: true, tokenData })
  } catch (e) {
    return apiResponses._400({ error: e.message })
  }
}

export async function lazyMint(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  const user = event.requestContext.authorizer.lambda.user
  const { contentId, dropId, signature } = JSON.parse(event.body)

  const contentItem = await getTokenForMinting({ dropId, contentId })

  // validate signature

  // store signature in DB

  // Call rarible API
  //  https://api-staging.rarible.com/protocol/v0.1/ethereum/nft/mints

  const creators = [{ account: user, value: 100000 }]

  const url = `${process.env.RARIBLE_API_URL_BASE}v0.1/ethereum/nft/mints`

  const result = await axios.post(
    url,
    {
      '@type': 'ERC721',
      token: process.env.TOKEN_CONTRACT_ADDRESS,
      tokenId: contentItem.TokenId,
      uri: contentItem.TokenUri,
      creators,
      royalties: [],
      signatures: [signature],
    },
    {
      headers: {
        'Content-Type': 'application/json',
      },
    }
  )

  console.log({ result })

  return apiResponses._200({ result })
}
