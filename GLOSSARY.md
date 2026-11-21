# SisaKu

SisaKu helps commercial kitchens in Indonesia cook the right amount, log what is binned, and report its cost and climate impact.

## Waste

**Waste entry**:
One record of food a kitchen threw away: which menu item, how much (kg, and portions when counted), why, and when.
_Avoid_: Waste log, waste record

**Waste cause**:
The reason food was thrown away: over-prep, spoilage, plate waste, prep error or expired.
_Avoid_: Reason, category

**Food category**:
The kind of food a menu item is mostly made of (rice, beef, chicken, ...), used to look up its emission factor.
_Avoid_: Category (that is the menu section), food type

## Impact

**Emission factor**:
The kg CO₂e caused per kg of a food category when it is wasted: a production part (growing and making the food) and a landfill part (methane as it rots).
_Avoid_: Carbon factor, emission rate

**CO₂e estimate**:
Waste weight multiplied by its emission factor. Always an estimate: the factors are global defaults, applied to cooked weight.
_Avoid_: Carbon footprint, emissions (without "estimate")

## Donations

**Food bank**:
An organisation that collects surplus food from kitchens and redistributes it. In the MVP the list is fictional mock data.
_Avoid_: Charity, NGO, donation partner

**Pickup request**:
A kitchen's request for a food bank to collect specific menu items and portion counts. It waits for approval before it can be submitted.
_Avoid_: Donation, pickup draft, order

**Approval**:
A manager's or owner's explicit yes to an action the agents proposed, recorded with who gave it. Agents can ask for approval but never give it.
_Avoid_: Confirmation, sign-off (when meaning the recorded decision)
