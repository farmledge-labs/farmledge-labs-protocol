import { Keypair } from '@stellar/stellar-base'
import {
  handleFarmerRegistration,
  registerFarmer,
  type FarmerRepository,
} from '../services/farmerRegistration.service'
import type { Farmer } from '../models/farmer.model'

const TEST_KEY_HEX = 'a'.repeat(64)

class InMemoryFarmerRepository implements FarmerRepository {
  readonly farmers: Farmer[] = []

  async findByPhone(phone: string): Promise<Farmer | null> {
    return this.farmers.find((farmer) => farmer.phone === phone) ?? null
  }

  async create(farmer: Farmer): Promise<Farmer> {
    this.farmers.push(farmer)
    return farmer
  }
}

beforeEach(() => {
  process.env['FARMER_KEY_ENCRYPTION_SECRET'] = TEST_KEY_HEX
})

afterAll(() => {
  delete process.env['FARMER_KEY_ENCRYPTION_SECRET']
})

describe('handleFarmerRegistration', () => {
  it('creates a farmer with a normalized phone and public Stellar key', async () => {
    const repository = new InMemoryFarmerRepository()

    const result = await handleFarmerRegistration(
      { phone: '+234 801-234-5678', PIN: '1234' },
      repository,
    )

    expect(result.statusCode).toBe(201)
    expect(result.body).toEqual({
      id: expect.any(String),
      phone: '+2348012345678',
      publicKey: expect.stringMatching(/^G[A-Z2-7]{55}$/),
    })
    expect(repository.farmers).toHaveLength(1)
    expect(repository.farmers[0]?.encryptedPrivateKey).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
    expect(repository.farmers[0]?.pinHash).toMatch(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/)
  })

  it('generates a usable Stellar keypair and never returns the secret key', async () => {
    const repository = new InMemoryFarmerRepository()
    const result = await registerFarmer(
      { phone: '+2348012345679', pin: '123456' },
      repository,
    )

    expect(() => Keypair.fromPublicKey(result.publicKey)).not.toThrow()
    expect(result).not.toHaveProperty('encryptedPrivateKey')
    expect(result).not.toHaveProperty('pinHash')
  })

  it('rejects a duplicate normalized phone number', async () => {
    const repository = new InMemoryFarmerRepository()
    await registerFarmer({ phone: '+2348012345680', PIN: '1234' }, repository)

    const result = await handleFarmerRegistration(
      { phone: '+234 801 234 5680', PIN: '5678' },
      repository,
    )

    expect(result).toEqual({
      statusCode: 409,
      body: { error: 'A farmer with this phone already exists' },
    })
    expect(repository.farmers).toHaveLength(1)
  })

  it.each([
    [{ PIN: '1234' }, 'phone is required'],
    [{ phone: '+2348012345681', PIN: '12' }, 'PIN must be a 4 to 6 digit number'],
    [{ phone: '+2348012345681', PIN: '12ab' }, 'PIN must be a 4 to 6 digit number'],
    [{ phone: 'not-a-phone', PIN: '1234' }, 'phone must be a valid international number'],
  ])('rejects invalid input %#', async (input, error) => {
    const repository = new InMemoryFarmerRepository()
    const result = await handleFarmerRegistration(input, repository)

    expect(result).toEqual({ statusCode: 400, body: { error } })
    expect(repository.farmers).toHaveLength(0)
  })
})
