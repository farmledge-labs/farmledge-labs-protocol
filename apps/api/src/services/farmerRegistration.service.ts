/**
 * Farmer registration service.
 *
 * This module deliberately depends on an injected repository rather than a
 * database client because the API application has no HTTP or persistence
 * adapter yet. A Postgres adapter can implement FarmerRepository without
 * changing registration behaviour.
 */

import { randomUUID, scrypt as scryptCallback, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { Keypair } from '@stellar/stellar-base'
import { encryptPrivateKey } from './farmerWalletSigner.service'
import type { Farmer } from '../models/farmer.model'

const scrypt = promisify(scryptCallback)

export interface FarmerRegistrationInput {
  phone?: unknown
  PIN?: unknown
  pin?: unknown
}

export interface FarmerRegistrationResponse {
  id: string
  phone: string
  publicKey: string
}

export interface FarmerRepository {
  findByPhone(phone: string): Promise<Farmer | null>
  create(farmer: Farmer): Promise<Farmer>
}

export class RegistrationError extends Error {
  constructor(
    public readonly statusCode: 400 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'RegistrationError'
  }
}

function normalizePhone(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RegistrationError(400, 'phone is required')
  }

  const phone = value.trim().replace(/[\s().-]/g, '')
  if (!/^\+?[1-9]\d{7,14}$/.test(phone)) {
    throw new RegistrationError(400, 'phone must be a valid international number')
  }
  return phone
}

function readPin(input: FarmerRegistrationInput): string {
  const value = input.PIN ?? input.pin
  if (typeof value !== 'string' || !/^\d{4,6}$/.test(value)) {
    throw new RegistrationError(400, 'PIN must be a 4 to 6 digit number')
  }
  return value
}

async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16)
  const derivedKey = (await scrypt(pin, salt, 64)) as Buffer
  return `scrypt:${salt.toString('hex')}:${derivedKey.toString('hex')}`
}

export function toPublicRegistrationResponse(
  farmer: Farmer,
): FarmerRegistrationResponse {
  return {
    id: farmer.id,
    phone: farmer.phone ?? '',
    publicKey: farmer.publicKey,
  }
}

export async function registerFarmer(
  input: FarmerRegistrationInput,
  repository: FarmerRepository,
): Promise<FarmerRegistrationResponse> {
  const phone = normalizePhone(input.phone)
  const pin = readPin(input)

  if (await repository.findByPhone(phone)) {
    throw new RegistrationError(409, 'A farmer with this phone already exists')
  }

  const keypair = Keypair.random()
  const farmer: Farmer = {
    id: randomUUID(),
    phone,
    publicKey: keypair.publicKey(),
    encryptedPrivateKey: encryptPrivateKey(keypair.secret()),
    pinHash: await hashPin(pin),
  }

  const storedFarmer = await repository.create(farmer)
  return toPublicRegistrationResponse(storedFarmer)
}

export interface RegistrationHandlerResult {
  statusCode: 201 | 400 | 409
  body: FarmerRegistrationResponse | { error: string }
}

export async function handleFarmerRegistration(
  input: FarmerRegistrationInput,
  repository: FarmerRepository,
): Promise<RegistrationHandlerResult> {
  try {
    return {
      statusCode: 201,
      body: await registerFarmer(input, repository),
    }
  } catch (error: unknown) {
    if (error instanceof RegistrationError) {
      return {
        statusCode: error.statusCode,
        body: { error: error.message },
      }
    }
    throw error
  }
}
