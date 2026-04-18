/**
   * @author Somesh Shakya
   * @description This API is used to create new campaigns
   * @param {*} req
   * @param {*} h
   */

/**
 * @global
 */
const Joi = require('@hapi/joi')

/**
  * @namespace
  */
const { debugLogger, errorLogger } = require('../../../../utils/logger')

const raffleCampaign = require('../../../../models/raffleCampaign')
const raffleCampaignTickets = require('../../../../models/raffleCampaignTickets')
const bulkUserEntry = require('../../../../models/bulkUserEntry');
const { generateCart } = require('../../../commonModels/generateEntries/generateCart')
const { extractNumber } = require('../../../commonModels/extractNumber')
const { generateOrder } = require('../../../commonModels/generateEntries/generateOrder')
const customerQRCode = require('../../../commonModels/customerQRCode')
const storeDB = require('../../../../models/stores')
const customer = require("../../../../models/customer")
const counters = require('../../../../models/counters')
const i18n = require('i18n')
const ObjectID = require('mongodb').ObjectID
const i18nConfig = require('../../../middleware/localization').options
i18n.configure(i18nConfig)
const csv = require('csv-parser');
const stream = require('stream');
const { getOne } = require('../../../../models/countries')
const constants = require('./constant')
const { countries, callingCountries } = require('country-data');
const wallet = require('../../../commonModels/wallet/walletTransaction');
const config = require('config');
const rp = require('request-promise');
const bcrypt = require('bcryptjs')
const moment = require('moment');
const masterOrder = require('../../../../models/masterOrder');
const nodeServer = config.get('APP_IP')

const IS_CAMPAIGN = config.get('IS_CAMPAIGN') === true || config.get('IS_CAMPAIGN') === 'true';
const CAMPAIGN_SERVER = config.get('CAMPAIGN_SERVER');
const walletServer = config.get('WALLET_SERVER')

/**
 * Helper: Create wallet for user
 */


async function createWalletForCustomer(customerDetails) {
    const requestCustomer = {
        headers: {
            authorization: JSON.stringify({
                userId: customerDetails.userId.toString(),
                userType: 'customer',
                metadata: {}
            })
        },
        payload: {},
        i18n
    };

    debugLogger.debug(`enterRaffleTicketFromCSV    :: calling GET ${walletServer}/ticketWalletAmount api`);

    try {
        await rp({
            method: 'GET',
            url: `${walletServer}/ticketWalletAmount`,
            headers: {
                authorization: requestCustomer.headers.authorization, lan: "en"
            },
            json: true
        });
        debugLogger.debug("enterRaffleTicketFromCSV    :: User Ticket Wallet Created.");
    } catch (err) {
        errorLogger.error(`error in GET ${walletServer}/ticketWalletAmount`, err);
    }

    const result = await wallet.createWallet(
        requestCustomer,
        customerDetails.userId.toString(),
        'customer',
        customerDetails.currencyCode,
        customerDetails.email.trim(),
        customerDetails.firstName,
        customerDetails.lastName,
        customerDetails.mobile
    );

    if (result?.length) {
        await customer.updateOne(
            { email: customerDetails.email },
            { $set: { createWallet: true } }
        );
    }

    return result;
}


/**
 * Helper: Send referral info
 */
async function sendReferral(customerDetails) {
    if (!IS_CAMPAIGN) return;

    const referralData = {
        userId: customerDetails.userId,
        userType: 1,
        referralCode: '',
        firstName: customerDetails.firstName,
        lastName: customerDetails.lastName,
        email: customerDetails.email.trim(),
        countryCode: customerDetails.countryCode,
        phoneNumber: customerDetails.mobile
    };

    const options = {
        uri: `${CAMPAIGN_SERVER}/referralCode`,
        headers: { 'Content-Type': 'application/json', language: 'en' },
        json: true,
        body: referralData
    };

    try {
        await rp.post(options);
    } catch (e) {
        errorLogger.error(`Referral error for user ${customerDetails.userId}:`, e.message);
    }
}


function getCountryInfoByName(nationality) {
    const country = countries.all.find(c =>
        c.name.toLowerCase() === nationality.toLowerCase() ||
        c.altNames?.some(a => a.toLowerCase() === nationality.toLowerCase())
    );

    if (!country) return {
        sortCountryCode: "US",
        countryCode: "+1"
    };

    const callingCountry = callingCountries.all.find(c => c.alpha2 === country.alpha2);

    return {
        sortCountryCode: country.alpha2.toUpperCase().split(" ")[0],       // e.g., 'in'
        countryCode: callingCountry ? `+${callingCountry.countryCallingCodes[0].replace('+', '').split(" ")[0]}` : ''
    };
}


function generatePassword(length = 12) {
    const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lowercase = "abcdefghijklmnopqrstuvwxyz";
    const digits = "0123456789";
    const special = "!@#$%^&*()_+[]{}<>?,.";

    const allChars = uppercase + lowercase + digits + special;

    // Ensure at least one from each category
    let password = [
        uppercase[Math.floor(Math.random() * uppercase.length)],
        lowercase[Math.floor(Math.random() * lowercase.length)],
        digits[Math.floor(Math.random() * digits.length)],
        special[Math.floor(Math.random() * special.length)],
    ];

    for (let i = password.length; i < length; i++) {
        password.push(allChars[Math.floor(Math.random() * allChars.length)]);
    }

    return password.sort(() => Math.random() - 0.5).join("");
}

const handler = async (req, h) => {
    debugLogger.debug("enterRaffleTicketFromCSV    :: request Details ----", {
        path: req.path,
        payload: req.payload,
        params: req.params,
        query: req.query
    });

    debugLogger.debug("enterRaffleTicketFromCSV    :: Request payload ===>", req.payload)

    let summary = {
        successCount: 0,
        failed: [],
        failedCount: 0,
        orderIds: new Map()
    };

    try {

        if (!req.payload || !req.payload.file) {
            return h.response({ message: 'CSV file is required' }).code(400);
        }

        if (!req.payload || !req.payload.campaignId) {
            return h.response({ message: 'campaignId is required' }).code(400);
        }

        const campaignId = req.payload.campaignId
        // --- Execute the chain ---

        // --- Step 1: Get campaign details ---
        const getCampaignDetails = async () => {
            const raffleCampaignData = await raffleCampaign.getOne({ _id: ObjectID(String(campaignId)) });
            if (!raffleCampaignData) throw new Error('Campaign data not found from ID');
            return raffleCampaignData;
        };

        const campaignData = await getCampaignDetails();
        if (!campaignData.countryTickets || !Array.isArray(campaignData.countryTickets)) {
            throw new Error("Invalid campaign configuration: countryTickets missing");
        }
        const storeData = await storeDB.getOne({ storeId: campaignData.storeId });
        if (!storeData) {
            throw new Error("Store data not found");
        }

        const countryId = await getOne({ countryName: "Puerto Rico" }, { _id: 1 })
        if (!countryId || !countryId._id) {
            throw new Error("Country (Puerto Rico) not found");
        }

        // --- Step 2: Add campaign entry (create cart) ---
        const addCampaignEntry = async ({ campaignData, customerDetails, row, ticketIdStr }) => {

            const headerAuthorization = JSON.stringify({
                userId: customerDetails.userId,
                _id: customerDetails.userId,
                userType: 'user',
                metaData: {},
            });

            const cartreq = {
                i18n,
                auth: {
                    credentials: {
                        userId: customerDetails.userId,
                        _id: customerDetails.userId,
                        sub: 'user',
                        metaData: {}
                    }
                },
                headers: {
                    authorization: headerAuthorization,
                    language: 'en',
                    platform: 3,
                    currencysymbol: '$',
                    currencycode: 'USD'
                },
                payload: {
                    cartZeroCheck: true,
                    campaignId: campaignId,
                    cartType: 2,
                    centralProductId: campaignData.parentProductId,
                    countryId: countryId._id,
                    estimatedProductPrice: 0,
                    extraNotes: '',
                    latitude: 0.0,
                    longitude: 0.0,
                    newQuantity: Number(row["Quantity"]),
                    offers: {
                        discountType: 0
                    },
                    oldQuantity: row["Variant Entries"],
                    productId: campaignData.childProductId,
                    productName: '',
                    storeCategoryId: storeData.categoryId,
                    storeId: campaignData.storeId,
                    storeTypeId: 8,
                    ticketId: ticketIdStr,
                    unitId: campaignData.unitId,
                    action: 1,
                    userIp: '192.168.1.25',
                    userType: 1,
                    typeOfCart: 1,
                    vehicleTypeId: '',
                    vehicleTypeName: '',
                    videoUserProfile: '',
                    weight: 0,
                    weightUnit: '',
                    width: 0,
                    widthUnit: '',
                    substituteProductAvailable: 0,
                    substituteProductId: '',
                    truckPackageTypeText: '',
                    sendPackageType: '',
                    singleTruck: false,
                    productImages: [
                    ],
                    pickUpAddressId: '',
                    orderType: 2,
                    palleteName: '',
                    palletId: '',
                    palletImage: '',
                    payByRewardWallet: false,
                    payByWallet: false,
                    paymentType: 2,
                    pickup: [
                    ],
                    numberOfBags: 1,
                    numberOfTrucks: 1,
                    numberofUnits: 0,
                    multiStop: false,
                    negotiation: false,
                    newBoxId: '',
                    length: 0,
                    lengthUnit: '',
                    loadImages: [
                    ],
                    fullContainerId: '',
                    fullContainerImage: '',
                    fullContainerName: '',
                    goodsValue: 0,
                    handlers: 0,
                    height: 0,
                    heightUnit: '',
                    isExpress: 0,
                    isMultiCart: 1,
                    extraNote: '',
                    coupon: '',
                    customerPaymentType: 2,
                    delivery: [
                    ],
                    deliveryAddressId: '',
                    deliveryFeePayBy: 2,
                    discount: 0,
                    cityId: '',
                    commodityId: '',
                    commodityImage: '',
                    commodityName: '',
                    cardBrand: '',
                    cardId: '',
                    cartId: '',
                    addToCartOnId: '',
                    budget: 0,
                    source: "CSV_IMPORT"
                },
                query: {},
                params: {}

            }
            const cartRes = await generateCart(cartreq);
            debugLogger.debug("enterRaffleTicketFromCSV    :: Cart Response:", JSON.stringify(cartRes));
            if (!cartRes || !cartRes.data) {
                return null;
            }

            if (cartRes.data.failedCountIncreament) {
                return cartRes.data;
            }

            if (!cartRes.data.cartId) {
                return null;
            }

            return cartRes.data.cartId;
        };

        // --- Step 3: Create entry order ---
        const createEntryOrder = async ({ cartId, customerDetails, row, Price, ticketIdStr }) => {

            const headerAuthorization = JSON.stringify({
                userId: customerDetails.userId,
                _id: customerDetails.userId,
                userType: 'user',
                metaData: {},
            });
            const orderReq = {
                i18n,
                auth: {
                    credentials: {
                        userId: customerDetails._id.toString(),
                        _id: customerDetails._id.toString(),
                        sub: 'user',
                        metaData: {}
                    }
                },
                headers: {
                    authorization: headerAuthorization,
                    language: 'en',
                    platform: 3,
                    currencysymbol: '$',
                    currencycode: 'USD'
                },
                payload: {
                    emailSend: true,
                    addressId: '',
                    billingAddressId: '',
                    cardId: '',
                    cartId: cartId,
                    contactLessDelivery: false,
                    coupon: '',
                    discount: 0.0,
                    extraNote: '',
                    ipAddress: '103.171.129.5',
                    latitude: 0.0,
                    longitude: 0.0,
                    onlinePaymentMethod: 0,
                    orderType: 2,
                    payByWallet: false,
                    paymentType: 2,
                    promoId: '',
                    storeType: 8,
                    userId: customerDetails.userId,
                    deviceSessionId: '',
                    geoSparkTripId: '',
                    shopifyOrderId: 0,
                    magentoOrderId: 0,
                    magentoUserToken: 0,
                    inAppPlanId: '',
                    pGTxnId: '',
                    payByRewardWallet: false,
                    pickup: [],
                    delivery: [],
                    orderImages: [],
                    deliveryFeePayBy: 2,
                    customerPaymentType: 2,
                    numberOfTrucks: 1,
                    paypalCaptureId: '',
                    bankTransferId: '',
                    bankTransferDate: 0,
                    bankTransferAmount: 0,
                    bankName: '',
                    bankTransferRecieptUrl: '',
                    rakbankSessionId: '',
                    rakbankSecurityKey: 0,
                    paymentTypeIsApplePay: false,
                    serviceLocationAt: 1,
                    price: Price,
                    customer_entries: (Number(row["Variant Entries"]) || 0) * (Number(row["Quantity"]) || 0),
                    ticketId: ticketIdStr,
                    quantity: row["Quantity"],
                    numberOfTicket: row["Variant Entries"],
                    paymentStatus: row["Order Payment Status"]?.toLowerCase(),
                    source: "CSV_IMPORT"
                },
                query: {},
                params: {}
            }
            if (row["Order ID"]) {
                orderReq.payload.CSV_order_ID = row["Order ID"]
            }
            if (row["No Voucher"]) {
                orderReq.payload.CSV_voucher = row["No Voucher"]
            }
            // debugLogger.debug("enterRaffleTicketFromCSV    ::enterRaffleTicketFromCSV    :: orderReq ==========>",orderReq)
            const createdOrder = await generateOrder(orderReq);
            // debugLogger.debug("enterRaffleTicketFromCSV    ::enterRaffleTicketFromCSV    :: createdOrder======>", createdOrder);
            return createdOrder;
        };


        const fileBuffer = req.payload.file;
        const bufferStream = new stream.PassThrough();
        bufferStream.end(fileBuffer);

        const rows = [];
        for await (const row of bufferStream.pipe(csv({}))) {
            rows.push(row);
        }

        debugLogger.debug(`enterRaffleTicketFromCSV    :: Total rows parsed: ${rows.length}` + rows);

        for await (const row of rows) {

            let ticketIdStr = '';

            debugLogger.debug("enterRaffleTicketFromCSV    :: Processing row =====>", row);
            // REQUIRED FIELDS → ONLY THESE MUST BE VALIDATED
            const requiredFields = [
                "Email",
                // "Phone Number",
                "First Name",
                "Last Name",
                "Variant Entries",
                "Price",
                "Quantity",
                "Order Payment Status"
            ];

            // Filter missing fields
            const missingFields = requiredFields.filter(
                field => row[field] === undefined || row[field] === null || String(row[field]).trim() === ""
            );


            if (missingFields.length > 0) {
                const reason = `Missing required fields: ${missingFields.join(', ')}`;
                row.reason = reason
                summary.failed.push({ rowData: row });
                summary.failedCount++;
                continue;
            }
            let Price = extractNumber.extractNumber(row["Price"])

            if (!Number.isFinite(Price) || Price <= 0) {
                const reason = `Invalid price: ${row["Price"]}`;
                row.reason = reason;
                summary.failed.push({ rowData: row });
                summary.failedCount++;
                continue;
            }

            const quantity = Number(row["Quantity"]);

            if (!Number.isFinite(quantity) || quantity <= 0) {
                const reason = `Invalid quantity: ${row["Quantity"]}`;
                row.reason = reason;
                summary.failed.push({ rowData: row });
                summary.failedCount++;
                continue;
            }

            // if (Number(row["Phone Number"]) <= 0) {
            //   const reason = `Invalid Phone Number : ${Number(row["Phone Number"])}`;
            //   row.reason = reason
            //   summary.failed.push({ rowData: row});
            //   summary.failedCount++;
            //   continue;
            // }


            // --- Get customer details ---
            const customers = await customer.get({ email: row.Email.trim().toLowerCase() });

            let customerDetails = customers[0];
            if (customerDetails) {
                // User exists → update missing fields if CSV has values
                const updateFields = {};

                let countryDetails = {
                    countryCode: "+1",
                    sortCountryCode: "PR"
                }
                if (row.Location) {
                    countryDetails = getCountryInfoByName(row.Location);
                }

                let number = ''
                if (row["Phone Number"] && row["Phone Number"] !== "NULL") {
                    const phone = row["Phone Number"];
                    number = phone.startsWith("+") ? phone.slice(-10) : phone.slice(-10);
                }

                if ((!customerDetails.mobile || customerDetails.mobile.trim() === '') && row["Phone Number"]) {
                    updateFields.mobile = number;
                    updateFields.number = number;
                    updateFields.countryCode = countryDetails.countryCode;
                    updateFields.sortCountryCode = countryDetails.sortCountryCode;
                }
                if ((!customerDetails.firstName || customerDetails.firstName.trim() === '') && row["First Name"]) {
                    updateFields.firstName = row["First Name"];
                }

                if ((!customerDetails.lastName || customerDetails.lastName.trim() === '') && row["Last Name"]) {
                    updateFields.lastName = row["Last Name"];
                }
                debugLogger.debug("enterRaffleTicketFromCSV    :: updateFields", updateFields)
                debugLogger.debug("enterRaffleTicketFromCSV    :: updateFields" + JSON.stringify(updateFields))
                // If there are fields to update, update DB
                if (Object.keys(updateFields).length > 0) {
                    await customer.updateOne(
                        { userId: customerDetails.userId },
                        { $set: updateFields }
                    );
                    debugLogger.debug(`enterRaffleTicketFromCSV    :: Updated existing user ${customerDetails.email} with missing fields: ${Object.keys(updateFields).join(', ')}`);
                }
            }


            if (!customerDetails) {
                debugLogger.debug(`enterRaffleTicketFromCSV    :: No customer found for email: ${row.Email}`);
                // continue;
                let password = generatePassword(10);
                let hashedPassword = await bcrypt.hash(
                    password,
                    Number(config.get('SALT_ROUNDS'))
                );
                const _id = new ObjectID();
                let countryDetails = {
                    countryCode: "+1",
                    sortCountryCode: "PR"
                }
                if (row.Location) {
                    countryDetails = getCountryInfoByName(row.Location);
                }

                let number = ''
                if (row["Phone Number"] && row["Phone Number"] !== "NULL") {
                    const phone = row["Phone Number"];
                    number = phone.startsWith("+") ? phone.slice(-10) : phone.slice(-10);
                }

                const body1 = {
                    _id: _id,
                    userId: _id.toString(),
                    storeId: "0",
                    isStoreCustomer: 0,
                    isRegisteredCustomer: 1,
                    isContactPerson: 0,
                    contactPersonUserId: "",
                    designation: "",
                    invoiceSent: false,
                    isRechargeWallet: false,
                    isTeamMemberAddRemove: false,
                    isContactDelete: false,
                    isUserContact: false,
                    isGuestUser: false,
                    isTeamMember: false,
                    userName: `${row["First Name"]} ${row["Last Name"]}`,
                    firstName: `${row["First Name"]}`,
                    lastName: `${row["Last Name"]}`,
                    email: `${row.Email.trim().toLowerCase()}`,
                    userType: constants.USER_TYPE.RETAILER,
                    userTypeText: "Retailer",
                    role: "",
                    roleType: -1,
                    roleTypeText: "",
                    customerType: constants.CUSTOMER_TYPE.B2C,
                    customerTypeText: "B2C customer",
                    institutionType: constants.INSTITUTION_TYPE.RETAIL_BUYER,
                    institutionTypeText: "Retail Buyer",
                    firstReferralSource: "app",
                    firstReferralSourceId: "0",
                    linkedSellers: [],
                    password: `${hashedPassword}`,
                    websiteUrl: "",
                    mobile: number,
                    number: number,
                    countryCode: number ? countryDetails.countryCode : '',
                    sortCountryCode: countryDetails.sortCountryCode,
                    currencySymbol: "$",
                    currencyCode: "USD",
                    zipCode: "",
                    city: "",
                    region: "",
                    country: countryDetails.countryCode,
                    dateOfBirth: "",
                    status: constants.CUSTOMER_STATUS.APPROVED,
                    statusMsg: "approved",
                    statusLogs: [
                        {
                            action: "approved",
                            status: 1,
                            actionByUserType: "guest",
                            actionByUserId: "",
                            timestamp: Date.now()
                        }
                    ],
                    statusBio: "Hey I am using DonRifa !",
                    lastStatusLog: {
                        action: "approved",
                        status: 1,
                        actionByUserType: "guest",
                        actionByUserId: "",
                        timestamp: Date.now()
                    },
                    facebookId: "",
                    appleId: "",
                    googleId: "",
                    location: {
                        lon: null,
                        lat: null
                    },
                    activeDeviceData: [],
                    socialMediaId: "",
                    loginType: 1,
                    loginTypeText: "NormalSignUp",
                    profilePic: "",
                    profileVideoThumbnail: "",
                    isKYCApproved: false,
                    isKYCStatus: 0,
                    isKYCStatusText: "Pending",
                    isKYCReason: "",
                    profileCoverImage: "",
                    qrCode: {
                        url: ""
                    },
                    termsAndCondition: constants.TERMS_AND_COND.TRUE,
                    paymetTermId: "",
                    paymetTerm: "",
                    customPaymentTerm: "",
                    createdDate: Date.now(),
                    createdTimestamp: Date.now(),
                    createdISOdate: moment().toDate(),
                    identityCard: {
                        url: "",
                        verified: false
                    },
                    mmjCard: {
                        url: "",
                        verified: false
                    },
                    mqttTopic: "",
                    fcmTopic: "",
                    emailVerified: false,
                    mobileVerified: true,
                    wallet: {
                        balance: 0,
                        blocked: 0,
                        hardLimit: 0,
                        softLimit: 0,
                        softLimitHit: false,
                        hardLimitHit: false
                    },
                    cityName: "",
                    cityId: "",
                    guestToken: false,
                    bage: 0,
                    count: {
                        followerCount: 0,
                        followeeCount: 0,
                        privateChannel: 0,
                        totalChannel: 0,
                        publicChannel: 0,
                        postsCount: 0
                    },
                    follow: [],
                    friendList: [],
                    myFriendRequest: [],
                    stream: {},
                    streamHistory: [],
                    businessProfile: [],
                    isActiveBusinessProfile: false,
                    iosAudioCallPush: "",
                    iosVideoCallPush: "",
                    iosMassageCallPush: "",
                    isdevelopment: false,
                    bookmarks: [],
                    blocked: [],
                    starChatId: "",
                    profileVideo: "",
                    groupCallStreamId: "",
                    subscribeChannels: [],
                    starRequest: {},
                    private: 0,
                    accessKey: "",
                    registrationDateIso: moment().toDate(),
                    registrationDateTimeStamp: "",
                    registeredOn: Date.now(),
                    creationDate: moment().toDate(),
                    seqId: null,
                    promoterAffiliateId: "",
                    document: "",
                    gender: constants.GENDER.MALE,
                    genderText: "Male",
                    nationality: `${row.Location}`,
                    isomatricChatUserId: "",
                    idProof: {
                        idProofTypeId: "",
                        idProofTypeTitle: "",
                        idProofFront: "",
                        idProofBack: "",
                        idProofStatus: 1
                    },
                    deviceInfo: {
                        userId: "",
                        deviceName: "",
                        deviceOs: "",
                        modelNumber: "",
                        deviceType: "",
                        appVersion: "",
                        deviceId: "",
                        timestamp: null,
                        creationDate: moment().toDate()
                    },
                    lastLogin: null,
                    languageCode: "es",
                    mobileDevices: {
                        appVersion: "",
                        browserName: "",
                        browserVersion: "",
                        currentlyActive: true,
                        deviceId: "",
                        deviceOsVersion: "",
                        deviceType: constants.DEVICE_TYPE.CSV_IMPORT,
                        deviceTypeMsg: "",
                        lastISOdate: moment().toDate(),
                        lastLogin: null,
                        lastTimestamp: null,
                        pushToken: ""
                    },
                    isOnlinestatus: 3,
                    onlineStatusMsg: "",
                    source: "CSV_IMPORT"
                }

                let result = await customer.createOne(body1);

                if (result) {
                    /** USER CREATED HERE */
                    let newUserId = result.insertedId.toString();
                    customerDetails = await customer.getData({ userId: newUserId });

                    debugLogger.debug(`enterRaffleTicketFromCSV    :: 🆕 User created with ID: ${newUserId}`);

                    /** ---- STEP: Create Wallet - Do NOT background ---- */
                    try {
                        await createWalletForCustomer(customerDetails);
                        debugLogger.debug(`enterRaffleTicketFromCSV    :: Wallet created for ${row.Email}`);
                    } catch (err) {
                        errorLogger.error(`Wallet error for ${row.Email}`, err);
                    }

                    /** ---- Background tasks ---- */
                    const localCustomer = customerDetails;
                    setImmediate(async () => {
                        try {

                            if (!localCustomer?.userId) {
                                errorLogger.error(`Skipping background flow: customerDetails missing for ${row.Email}`);
                                return;
                            }

                            /** ---- STEP 1: Assign Seq ID ---- **/
                            try {
                                const customerSeqId = await counters.getSequenceNumberByName('CUSTOMER-SEQ-ID', false);

                                await customer.updateOne(
                                    { userId: localCustomer.userId },
                                    {
                                        $set: {
                                            seqId: customerSeqId,
                                            mqttTopic: `MQTT-${localCustomer.userId}${moment().unix()}`,
                                            fcmTopic: `FCM-${localCustomer.userId}`
                                        }
                                    }
                                );

                                debugLogger.debug(`enterRaffleTicketFromCSV    :: SEQ ID created for ${row.Email}`);
                            } catch (err) {
                                errorLogger.error(`SEQ ID update failed for ${row.Email}`, err);
                            }

                            /** ---- STEP 2: Generate QR ---- **/
                            try {
                                const qrCodeUrlData = await customerQRCode.qrCodeGenerate(localCustomer.userId, 3);
                                await customer.updateOne({ userId: localCustomer.userId }, { $set: { "qrCode.url": qrCodeUrlData } });

                                debugLogger.debug(`enterRaffleTicketFromCSV    :: QR Code generated for ${row.Email}`);
                            } catch (err) {
                                errorLogger.error(`QR code error for ${row.Email}`, err);
                            }

                            /** ---- STEP 3: Referral ---- **/
                            try {
                                await sendReferral(localCustomer);
                                debugLogger.debug(`enterRaffleTicketFromCSV    :: Referral sent for ${row.Email}`);
                            } catch (err) {
                                errorLogger.error(`Referral error for ${row.Email}`, err);
                            }

                            debugLogger.debug(`enterRaffleTicketFromCSV    :: Background processing completed for: ${row.Email}`);

                        } catch (err) {
                            errorLogger.error(`Background job failed for ${row.Email}`, err);
                        }
                    });

                }
            }

            if (!customerDetails) {
                const reason = "Customer creation failed";
                row.reason = reason;
                summary.failed.push({ rowData: row });
                summary.failedCount++;
                continue;
            }
            // Find the country ticket data
            let countryTicketData = campaignData.countryTickets.find(
                country => country.countryId.toString() === countryId._id.toString()
            );

            if (!countryTicketData) {
                debugLogger.error(" No country ticket data found for country:", countryId._id);
                const reason = "Tickets for Puerto Rico are not available in this raffle campaign";
                row.reason = reason;
                summary.failed.push({ rowData: row });
                summary.failedCount++;
                continue;
            }

            debugLogger.debug("enterRaffleTicketFromCSV    :: countryTicketData:", JSON.stringify(countryTicketData));

            const variantEntries = Number(row["Variant Entries"]);
            const variantPrice = Price;

            let ticket = countryTicketData?.tickets.find(t =>
                Number(t.numberOfTicket) === variantEntries &&
                Number(t.price) === variantPrice
            );

            if (!ticket) {
                debugLogger.warn("enterRaffleTicketFromCSV   ::  No matching ticket found.");

                ticket = {
                    price: Number(Price),
                    numberOfTicket: row["Variant Entries"],
                    ticketId: new ObjectID(),
                    CSVvariant: true
                };

                await raffleCampaign.updateOne({
                    _id: new ObjectID(campaignId),
                    "countryTickets.countryId": countryId._id.toString()
                }, {
                    $push: {
                        "countryTickets.$.tickets": ticket
                    }
                });

                //Setting the refereces.
                countryTicketData.tickets.push(ticket);
            }

            if (ticket && ticket.ticketId) {
                ticketIdStr = ticket.ticketId.toHexString ? ticket.ticketId.toHexString() : ticket.ticketId.toString();
                debugLogger.debug("enterRaffleTicketFromCSV    :: ticketId string:", ticketIdStr);
            } else {
                debugLogger.error("No ticketId found even in fallback!");
                const reason = "Ticket creation failed";
                row.reason = reason;
                summary.failed.push({ rowData: row });
                summary.failedCount++;
                continue;
            }

            // const matchCondition = {
            //     campaignId: campaignId,
            //     userId: customerDetails.userId,
            //     raffleTicketId: ObjectID(ticketIdStr)
            // };
            // // Build the aggregation pipeline
            // const pipeline = [
            //     { $match: matchCondition },
            //     { $count: "totalEntries" }
            // ];

            // // Run the aggregation
            // let result = await raffleCampaignTickets.aggregate(pipeline);
            // const totalEntries = result.length ? result[0].totalEntries : 0;

            const cartId = await addCampaignEntry({
                campaignData,
                customerDetails,
                row,
                ticketIdStr
            });
            if (!cartId || cartId.failedCountIncreament) {
                const reason = `Cart creation failed or campaign limit reached`;
                debugLogger.debug(`enterRaffleTicketFromCSV    :: Row rejected → ${reason}`, row);
                row.reason = reason
                summary.failed.push({ rowData: row });
                summary.failedCount++;
                continue;
            }

            const orderId = await createEntryOrder({
                cartId,
                customerDetails,
                row,
                Price,
                ticketIdStr
            });
            debugLogger.debug("enterRaffleTicketFromCSV    :: Order Response:", JSON.stringify(orderId));
            if (!orderId || !orderId.data || !orderId.data.orderId) {
                const reason = "Order creation failed or incomplete response";
                row.reason = reason;
                summary.failed.push({ rowData: row });
                summary.failedCount++;
                continue;
            }

            summary.orderIds.set(
                orderId.data.orderId,
                orderId.data.productOrderIdRes
            );

            summary.successCount++;
        }
        return h.response({ msg: 'All raffle campaign entries processed successfully', data: summary }).code(200);

    } catch (err) {
        console.log(summary);
        console.log("orderIds size ===>", summary?.orderIds?.size);

        let rollbackFailed = [];

        if (summary?.orderIds && summary.orderIds.size !== 0) {

            for (const [masterOrderId, productOrderIds] of summary.orderIds) {

                const userId = "65660bfbc3d13250070067b4";
                const userType = "admin";

                const data = {
                    type: 'productOrder',
                    orderId: productOrderIds,
                    reason: 'Payment Failed -- CSV RollBack',
                    comment: 'Payment Failed -- CSV RollBack',
                    prescriptionRequired: false,
                    paymentFailed: true,
                    idProofRequired: false,
                };

                const options = {
                    method: 'DELETE',
                    url: `${nodeServer}v1/order`,
                    headers: {
                        authorization: JSON.stringify({
                            userType: userType,
                            userId: userId,
                            metaData: {
                                id: userId,
                                name: '',
                                email: '',
                                mobile: '',
                                countryCode: '',
                                role: ''
                            }
                        }),
                        language: 'en',
                        platform: 2,
                        currencysymbol: 'USD',
                        currencycode: 'USD'
                    },
                    body: data,
                    json: true
                };
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        const res = await rp(options);

                        if (!res || res.error) {
                            throw new Error("Rollback API logical failure");
                        }

                        debugLogger.debug(`enterRaffleTicketFromCSV    :: Rollback worked for masterOrderId: ${masterOrderId} (attempt ${attempt})`);
                        success = true;
                        break;

                    } catch (errorTry) {
                        errorLogger.error(`Rollback attempt ${attempt} failed for ${masterOrderId}`, errorTry);

                        if (attempt === 3) {
                            rollbackFailed.push(masterOrderId);
                        }
                    }
                }
            }
        }
        if (rollbackFailed.length > 0) {
            errorLogger.error("Partial rollback failure. These orders may be inconsistent:", rollbackFailed);
        } else {
            debugLogger.debug("enterRaffleTicketFromCSV    :: Rollback completed successfully for all orders");
        }

        errorLogger.error("Handler error:", err);

        return h.response({
            msg: err.message,
            rollbackFailed
        }).code(500);
    }
}

/**
  * response validation
  */
const response = {
    status: {
        200: Joi.object({
            message: Joi.any().example(i18n.__('postRaffleCampaign.response.200')).description(i18n.__('postRaffleCampaign.responseDescription.200'))
        }).description(i18n.__('postRaffleCampaign.responseDescription.200')),
        500: Joi.object({
            message: Joi.any().example(i18n.__('common.response.500')).description(i18n.__('common.responseDescription.500'))
        }).description(i18n.__('common.responseDescription.500'))
    },
    failAction: 'log'
}

module.exports = { handler, response }