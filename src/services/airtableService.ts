interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

interface AirtableResponse {
  records: AirtableRecord[];
  offset?: string;
}

export interface ExistingLead {
  propertyId: string;
  ownerName: string;
}

const PAT = (import.meta.env.VITE_AIRTABLE_PAT || '').replace(/^["']|["']$/g, '');
const BASE_ID = (import.meta.env.VITE_AIRTABLE_BASE_ID || '').replace(/^["']|["']$/g, '');
const TABLE_NAME = (import.meta.env.VITE_AIRTABLE_TABLE_NAME || '').replace(/^["']|["']$/g, '');
const FIELD_PROPERTY_ID = (import.meta.env.VITE_AIRTABLE_FIELD_PROPERTY_ID || 'PROPERTY_ID').replace(/^["']|["']$/g, '');
const FIELD_OWNER_NAME = (import.meta.env.VITE_AIRTABLE_FIELD_OWNER_NAME || 'OWNER_NAME').replace(/^["']|["']$/g, '');

class AirtableService {
  /**
   * Fetches all existing leads from Airtable by iterating through all pages.
   * Only retrieves the PROPERTY_ID and OWNER_NAME fields for efficiency.
   */
  async fetchAllExistingLeads(): Promise<ExistingLead[]> {
    if (!PAT || !BASE_ID || !TABLE_NAME) {
      throw new Error('Airtable configuration is missing in environment variables.');
    }

    const allLeads: ExistingLead[] = [];
    let offset: string | undefined = undefined;

    // Use URLSearchParams for clean URL building
    const baseUrl = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_NAME)}`;
    
    try {
      do {
        const url = new URL(baseUrl);
        url.searchParams.append('fields[]', FIELD_PROPERTY_ID);
        url.searchParams.append('fields[]', FIELD_OWNER_NAME);
        if (offset) {
          url.searchParams.append('offset', offset);
        }

        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${PAT}`,
          },
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Airtable API error: ${response.status} ${response.statusText}. ${errorData.error?.message || ''}`
          );
        }

        const data: AirtableResponse = await response.json();
        
        for (const record of data.records) {
          const propertyId = record.fields[FIELD_PROPERTY_ID];
          const ownerName = record.fields[FIELD_OWNER_NAME];
          
          if (propertyId && ownerName) {
            allLeads.push({
              propertyId: String(propertyId).trim(),
              ownerName: String(ownerName).trim(),
            });
          }
        }

        offset = data.offset;
      } while (offset);

      return allLeads;
    } catch (error) {
      console.error('Failed to fetch from Airtable:', error);
      throw error;
    }
  }
}

export const airtableService = new AirtableService();
